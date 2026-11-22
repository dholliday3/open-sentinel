// Checks on the measurement. A count is only as good as the labeler behind it, so every question
// needs a small sample someone has checked. From that sample: how well the labeler agrees, where
// each gate should sit, whether its probabilities mean what they say, and what the true rate is
// behind a counted one. Run these again whenever the labeler's version changes.
import { on } from "./metrics.ts";
import type { Counts } from "./stats.ts";
import type { Gates, LabeledEvent } from "./types.ts";

/**
 * One checked fact: for this event, the true answer for this signal. From a person, or from a
 * stronger model standing in for one. `weight` is how many events in the stream this one stands
 * for, when the sample over-picked some kinds on purpose (see `auditSample`). Default 1.
 */
export interface AuditLabel {
  id: string;
  signal: string;
  truth: boolean;
  weight?: number;
}

export interface Agreement {
  signal: string;
  /** Checked events, and how many of them are truly yes. */
  checked: number;
  positives: number;
  /** Weighted counts: labeler yes and truly yes, yes and truly no, no and truly yes, no and truly no. */
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Agreement beyond chance: 1 is perfect, above 0.8 is strong, 0 is chance. */
  kappa: number;
  /** Of the labeler's yeses, the share that are right. */
  precision: number;
  /** Of the true yeses, the share the labeler finds. */
  recall: number;
  /** Of the true nos, the share the labeler calls no. */
  specificity: number;
  /**
   * How many evenly weighted checks the true yeses and the true nos are worth. Equal to their
   * counts when every weight is 1; fewer when a few heavily weighted events carry the estimate.
   */
  effective: { yes: number; no: number };
}

interface Pair {
  p: number;
  truth: boolean;
  weight: number;
}

const pairsBySignal = (labeled: readonly LabeledEvent[], audit: readonly AuditLabel[]): Map<string, Pair[]> => {
  const byId = new Map(labeled.map((event) => [event.id, event]));
  const pairs = new Map<string, Pair[]>();
  for (const label of audit) {
    const event = byId.get(label.id);
    if (!event) {
      continue;
    }
    const list = pairs.get(label.signal) ?? [];
    // A joined key has no probability of its own; it is yes (1) or no (0) at the parts' gates.
    list.push({ p: label.signal.includes("&") ? (on(label.signal)(event) ? 1 : 0) : (event.signals[label.signal] ?? 0), truth: label.truth, weight: label.weight ?? 1 });
    pairs.set(label.signal, list);
  }
  return pairs;
};

const tally = (signal: string, pairs: readonly Pair[], gate: number): Agreement => {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const squares = { yes: 0, no: 0 };
  for (const { p, truth, weight } of pairs) {
    c[p >= gate ? (truth ? "tp" : "fp") : truth ? "fn" : "tn"] += weight;
    squares[truth ? "yes" : "no"] += weight ** 2;
  }
  const n = c.tp + c.fp + c.fn + c.tn;
  const agree = (c.tp + c.tn) / n;
  const chance = ((c.tp + c.fp) / n) * ((c.tp + c.fn) / n) + ((c.fn + c.tn) / n) * ((c.fp + c.tn) / n);
  return {
    signal,
    checked: pairs.length,
    positives: pairs.filter((pair) => pair.truth).length,
    ...c,
    kappa: chance === 1 ? Number.NaN : (agree - chance) / (1 - chance),
    precision: c.tp / (c.tp + c.fp),
    recall: c.tp / (c.tp + c.fn),
    specificity: c.tn / (c.tn + c.fp),
    // Kish's effective sample size: (sum of weights)^2 / sum of squared weights.
    effective: { yes: squares.yes > 0 ? (c.tp + c.fn) ** 2 / squares.yes : 0, no: squares.no > 0 ? (c.tn + c.fp) ** 2 / squares.no : 0 },
  };
};

/** How well the labeler agrees with the checked sample, per signal, at the given gates. */
export const agreement = (labeled: readonly LabeledEvent[], audit: readonly AuditLabel[], gates: Gates = {}): Agreement[] =>
  [...pairsBySignal(labeled, audit)].map(([signal, pairs]) => tally(signal, pairs, gates[signal] ?? 0.5));

export interface FittedGate extends Agreement {
  gate: number;
  /** Why the gate was left at its default, when it was. */
  kept?: string;
}

/**
 * Sets each signal's gate from the checked sample.
 *   "kappa"          the gate with the most agreement beyond chance. For signals you count.
 *   { precision }    the lowest gate whose yeses are right at least this often. For signals that
 *                    page someone: it finds the most it can while keeping false pages down.
 * A signal with fewer than `minPositives` checked true yeses keeps its current gate: too little
 * to fit on. Gates fitted and scored on the same sample flatter themselves; check them on a
 * fresh one before trusting the numbers.
 */
export const fitGates = (labeled: readonly LabeledEvent[], audit: readonly AuditLabel[], { gates = {}, candidates = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], objective = "kappa", minPositives = 5 }: { gates?: Gates; candidates?: readonly number[]; objective?: "kappa" | { precision: number }; minPositives?: number } = {}): { gates: Gates; fitted: FittedGate[] } => {
  const fitted = [...pairsBySignal(labeled, audit)]
    .filter(([signal]) => !signal.includes("&"))
    .map(([signal, pairs]): FittedGate => {
      const current = gates[signal] ?? 0.5;
      const positives = pairs.filter((pair) => pair.truth).length;
      if (positives < minPositives) {
        return { ...tally(signal, pairs, current), gate: current, kept: `only ${positives} checked yes; needs ${minPositives}` };
      }
      const scored = [...candidates].sort((a, b) => a - b).map((gate) => ({ ...tally(signal, pairs, gate), gate }));
      if (objective === "kappa") {
        return scored.reduce((best, next) => ((next.kappa || -1) > (best.kappa || -1) ? next : best));
      }
      const precise = scored.find((s) => s.precision >= objective.precision);
      return precise ?? { ...scored.at(-1)!, kept: `no gate reaches ${objective.precision} precision` };
    });
  return { gates: { ...gates, ...Object.fromEntries(fitted.map((f) => [f.signal, f.gate])) }, fitted };
};

/**
 * Do the labeler's probabilities mean what they say? Checked answers in equal bins of probability:
 * of the answers near 0.8, about 80% should be yes. `ece` is the average gap, weighted by how many
 * answers sit in each bin.
 */
export const calibration = (labeled: readonly LabeledEvent[], audit: readonly AuditLabel[], { bins = 10 }: { bins?: number } = {}): { rows: Array<{ from: number; to: number; checked: number; meanProbability: number; observedYes: number }>; ece: number; brier: number } => {
  const pairs = [...pairsBySignal(labeled, audit)].filter(([signal]) => !signal.includes("&")).flatMap(([, list]) => list);
  const total = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  const rows = Array.from({ length: bins }, (_, i) => {
    const from = i / bins;
    const to = (i + 1) / bins;
    const inBin = pairs.filter((pair) => pair.p >= from && (pair.p < to || (i === bins - 1 && pair.p <= 1)));
    const weight = inBin.reduce((sum, pair) => sum + pair.weight, 0);
    return {
      from,
      to,
      checked: inBin.length,
      weight,
      meanProbability: inBin.reduce((sum, pair) => sum + pair.p * pair.weight, 0) / weight,
      observedYes: inBin.reduce((sum, pair) => sum + (pair.truth ? pair.weight : 0), 0) / weight,
    };
  });
  return {
    rows: rows.map(({ weight: _weight, ...row }) => row),
    ece: rows.reduce((sum, row) => sum + (row.weight > 0 ? (row.weight / total) * Math.abs(row.meanProbability - row.observedYes) : 0), 0),
    brier: pairs.reduce((sum, pair) => sum + pair.weight * (pair.p - (pair.truth ? 1 : 0)) ** 2, 0) / total,
  };
};

/**
 * The true rate behind a counted one, given how the labeler did on the checked sample
 * (the Rogan-Gladen correction). A labeler that calls 3% of events yes, misses a tenth of the true
 * ones and wrongly flags 1% of the rest is counting a true rate nearer 2.2%. Use this for any
 * number shown as a fact. Alerts need it less: they compare one week with another under the same
 * labeler, so a steady error mostly cancels.
 *
 * The interval covers both the stream's sampling and the checked sample's. It is wide when few
 * true yeses were checked, and `usable` is false when the labeler barely beats chance. Pass an
 * `Agreement` as it comes from `agreement`: its `effective` sizes keep a weighted sample from
 * looking larger than it is. It is an approximation that errs wide, most of all on a weighted
 * sample and when few true yeses were checked.
 */
export const correctedRate = (observed: Counts, checked: Pick<Agreement, "tp" | "fp" | "fn" | "tn"> & Partial<Pick<Agreement, "effective">>, z = 1.96): { rate: number; low: number; high: number; usable: boolean } => {
  const yeses = checked.tp + checked.fn;
  const nos = checked.tn + checked.fp;
  const sensitivity = checked.tp / yeses;
  const specificity = checked.tn / nos;
  const separation = sensitivity + specificity - 1;
  if (!(separation > 0.2) || observed.total === 0) {
    return { rate: Number.NaN, low: 0, high: 1, usable: false };
  }
  const counted = observed.yes / observed.total;
  const rate = Math.min(1, Math.max(0, (counted + specificity - 1) / separation));
  // Weighted counts say what share was right, not how many checks stand behind it.
  const nYes = checked.effective?.yes ?? yeses;
  const nNo = checked.effective?.no ?? nos;
  // A perfect score on a small sample is not certainty: one extra hit and miss keep the spread honest.
  const se = (sensitivity * nYes + 1) / (nYes + 2);
  const sp = (specificity * nNo + 1) / (nNo + 2);
  const variance = ((counted * (1 - counted)) / observed.total + (rate ** 2 * se * (1 - se)) / nYes + ((1 - rate) ** 2 * sp * (1 - sp)) / nNo) / separation ** 2;
  const half = z * Math.sqrt(variance);
  return { rate, low: Math.max(0, rate - half), high: Math.min(1, rate + half), usable: true };
};

/**
 * Picks events for someone to check, for one signal: some from each band of probability, so the
 * rare confident yeses and the unsure middle are both covered. Each comes with the weight to pass
 * on in its `AuditLabel`, so the over-picked bands don't skew the results.
 */
export const auditSample = (labeled: readonly LabeledEvent[], { signal, perBand = 25, bands = [0, 0.1, 0.5, 0.9], random = Math.random }: { signal: string; perBand?: number; bands?: readonly number[]; random?: () => number }): Array<{ event: LabeledEvent; weight: number }> =>
  bands.flatMap((from, i) => {
    const to = bands[i + 1] ?? Infinity;
    const inBand = labeled.filter((event) => {
      const p = event.signals[signal] ?? 0;
      return p >= from && p < to;
    });
    // A partial shuffle: the first `take` places end up a uniform random pick.
    const pool = [...inBand];
    const take = Math.min(perBand, pool.length);
    for (let k = 0; k < take; k += 1) {
      const swap = k + Math.floor(random() * (pool.length - k));
      [pool[k], pool[swap]] = [pool[swap]!, pool[k]!];
    }
    return pool.slice(0, take).map((event) => ({ event, weight: inBand.length / take }));
  });

/**
 * The same events under two labelers (two versions, or two models): how often each signal's
 * answer flips at its gate, and how far the probabilities move. Run it before changing version;
 * a signal whose share moves is a metric that will jump on the day you switch.
 */
export const compareLabelers = (before: readonly LabeledEvent[], after: readonly LabeledEvent[], gates: Gates = {}): { events: number; flipRate: number; signals: Array<{ signal: string; flips: number; flipRate: number; meanMove: number; shareBefore: number; shareAfter: number }> } => {
  const later = new Map(after.map((event) => [event.id, event]));
  const both = before.flatMap((event) => (later.has(event.id) ? [[event, later.get(event.id)!] as const] : []));
  const keys = [...new Set(both.flatMap(([a, b]) => [...Object.keys(a.signals), ...Object.keys(b.signals)]))].filter((key) => !key.endsWith(".second"));
  const signals = keys.map((signal) => {
    const isOn = on(signal, gates);
    let flips = 0;
    let moved = 0;
    let yesBefore = 0;
    let yesAfter = 0;
    for (const [a, b] of both) {
      flips += isOn(a) === isOn(b) ? 0 : 1;
      moved += Math.abs((a.signals[signal] ?? 0) - (b.signals[signal] ?? 0));
      yesBefore += isOn(a) ? 1 : 0;
      yesAfter += isOn(b) ? 1 : 0;
    }
    return { signal, flips, flipRate: flips / both.length, meanMove: moved / both.length, shareBefore: yesBefore / both.length, shareAfter: yesAfter / both.length };
  });
  return { events: both.length, flipRate: signals.reduce((sum, s) => sum + s.flips, 0) / Math.max(1, both.length * signals.length), signals };
};
