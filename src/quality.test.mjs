import assert from "node:assert/strict";
import { test } from "node:test";
import { agreement, auditSample, calibration, compareLabelers, correctedRate, fitGates } from "./quality.ts";
import { seeded } from "./testing.ts";

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);
const event = (id, signals) => ({ id, at: 0, schema: "t@1", labeler: "l", probability: "native", signals });

// Ten checked events: the labeler's probability that each is a bug report, and the truth.
const PROBABILITY = [0.95, 0.9, 0.8, 0.6, 0.55, 0.4, 0.3, 0.2, 0.1, 0.05];
const TRUTH = [true, true, true, false, true, false, false, true, false, false];
const labeled = PROBABILITY.map((p, i) => event(`e${i}`, { bug: p }));
const audit = TRUTH.map((truth, i) => ({ id: `e${i}`, signal: "bug", truth }));

test("agreement counts the four outcomes at the gate", () => {
  const [bug] = agreement(labeled, audit);
  assert.deepEqual([bug.tp, bug.fp, bug.fn, bug.tn, bug.checked, bug.positives], [4, 1, 1, 4, 10, 5]);
  near(bug.precision, 0.8);
  near(bug.recall, 0.8);
  near(bug.specificity, 0.8);
  near(bug.kappa, 0.6);
  near(agreement(labeled, audit, { bug: 0.9 })[0].recall, 0.4);
});

test("agreement skips labels for events it doesn't have, and weights the rest", () => {
  const weighted = [...audit.slice(0, 9), { ...audit[9], weight: 11 }, { id: "missing", signal: "bug", truth: true }];
  const [bug] = agreement(labeled, weighted);
  assert.deepEqual([bug.tn, bug.checked], [14, 10]);
  near(bug.specificity, 14 / 15);
  // Five true nos, one of them standing for eleven: worth fewer than two evenly weighted checks.
  near(bug.effective.no, 15 ** 2 / (4 + 11 ** 2));
  assert.deepEqual(agreement(labeled, audit)[0].effective, { yes: 5, no: 5 });
});

test("fitGates picks the gate that agrees best, the lowest on a tie", () => {
  const { gates, fitted } = fitGates(labeled, audit);
  assert.equal(gates.bug, 0.5);
  near(fitted[0].kappa, 0.6);
});

test("fitGates can aim for precision instead: the lowest gate whose yeses are right often enough", () => {
  const { gates, fitted } = fitGates(labeled, audit, { objective: { precision: 1 } });
  assert.equal(gates.bug, 0.7);
  assert.deepEqual([fitted[0].tp, fitted[0].fp], [3, 0]);
  const out = fitGates(labeled, audit.map((label, i) => ({ ...label, truth: i === 9 })), { objective: { precision: 0.9 }, minPositives: 1 });
  assert.match(out.fitted[0].kept, /no gate reaches 0.9/);
});

test("fitGates keeps a gate it has too few checked yeses to move, and keeps gates it wasn't asked about", () => {
  const { gates, fitted } = fitGates(labeled, audit, { gates: { bug: 0.6, other: 0.8 }, minPositives: 6 });
  assert.deepEqual(gates, { bug: 0.6, other: 0.8 });
  assert.match(fitted[0].kept, /only 5 checked yes/);
});

test("calibration bins checked answers by probability", () => {
  const { rows, ece, brier } = calibration(labeled, audit, { bins: 2 });
  assert.deepEqual(rows.map((row) => row.checked), [5, 5]);
  near(rows[0].meanProbability, 0.21);
  near(rows[0].observedYes, 0.2);
  near(rows[1].meanProbability, 0.76);
  near(rows[1].observedYes, 0.8);
  near(ece, 0.5 * 0.01 + 0.5 * 0.04);
  assert.ok(brier > 0.1 && brier < 0.2);
});

test("correctedRate undoes a labeler's misses and false yeses", () => {
  // Finds 90% of true yeses and wrongly flags 1% of the rest: a counted 3% is a true 2.2%.
  const { rate, low, high, usable } = correctedRate({ yes: 30, total: 1000 }, { tp: 90, fn: 10, fp: 9, tn: 891 });
  near(rate, (0.03 + 0.99 - 1) / 0.89);
  assert.ok(usable && low < rate && rate < high && low > 0 && high < 0.05);
  assert.equal(correctedRate({ yes: 30, total: 1000 }, { tp: 50, fn: 50, fp: 50, tn: 50 }).usable, false);
});

test("correctedRate's interval covers the truth about as often as it claims", () => {
  const random = seeded(7);
  const TRUE_RATE = 0.05;
  const draw = (count, yesShare, hitYes, hitNo) => {
    const checked = { tp: 0, fn: 0, fp: 0, tn: 0 };
    let counted = 0;
    for (let i = 0; i < count; i += 1) {
      const truth = random() < yesShare;
      const said = random() < (truth ? hitYes : 1 - hitNo);
      counted += said ? 1 : 0;
      checked[truth ? (said ? "tp" : "fn") : said ? "fp" : "tn"] += 1;
    }
    return { counted, checked };
  };
  let covered = 0;
  let sumCorrected = 0;
  let sumCounted = 0;
  const TRIALS = 400;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const stream = draw(4000, TRUE_RATE, 0.85, 0.97);
    // The checked sample: 150 true yeses and 450 true nos, picked apart from the stream.
    const yeses = draw(150, 1, 0.85, 0.97).checked;
    const nos = draw(450, 0, 0.85, 0.97).checked;
    const result = correctedRate({ yes: stream.counted, total: 4000 }, { tp: yeses.tp, fn: yeses.fn, fp: nos.fp, tn: nos.tn });
    covered += result.low <= TRUE_RATE && TRUE_RATE <= result.high ? 1 : 0;
    sumCorrected += result.rate;
    sumCounted += stream.counted / 4000;
  }
  near(sumCounted / TRIALS, 0.85 * 0.05 + 0.03 * 0.95, 0.002);
  near(sumCorrected / TRIALS, TRUE_RATE, 0.003);
  // A 95% interval. Over 400 trials, chance alone moves the share covered by about a point.
  assert.ok(covered / TRIALS >= 0.93 && covered / TRIALS <= 0.975, `covered ${covered / TRIALS}`);
});

test("correctedRate doesn't mistake a weighted sample for a large one", () => {
  // The checked sample over-picks the labeler's yeses: 100 of them and 200 of its nos, each
  // weighted back to what it stands for in a stream of 3,000. The weights add up to 3,000 checks;
  // only 300 were made.
  const random = seeded(7);
  const TRUE_RATE = 0.05;
  const SIZE = 3000;
  const TRIALS = 150;
  const draw = () => Array.from({ length: SIZE }, (_, i) => {
    const truth = random() < TRUE_RATE;
    return { ...event(`e${i}`, { bug: random() < (truth ? 0.85 : 0.03) ? 1 : 0 }), truth };
  });
  const pick = (from, take) => {
    const pool = [...from];
    for (let k = 0; k < take; k += 1) {
      const swap = k + Math.floor(random() * (pool.length - k));
      [pool[k], pool[swap]] = [pool[swap], pool[k]];
    }
    return pool.slice(0, take).map((e) => ({ id: e.id, signal: "bug", truth: e.truth, weight: from.length / take }));
  };
  let covered = 0;
  let coveredAsCounts = 0;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const counted = draw().filter((e) => e.signals.bug === 1).length;
    const pool = draw();
    const [checked] = agreement(pool, [...pick(pool.filter((e) => e.signals.bug === 1), 100), ...pick(pool.filter((e) => e.signals.bug === 0), 200)]);
    assert.ok(checked.effective.yes < 100 && checked.tp + checked.fn > 100);
    const result = correctedRate({ yes: counted, total: SIZE }, checked);
    const { effective: _effective, ...asCounts } = checked;
    const narrow = correctedRate({ yes: counted, total: SIZE }, asCounts);
    covered += result.low <= TRUE_RATE && TRUE_RATE <= result.high ? 1 : 0;
    coveredAsCounts += narrow.low <= TRUE_RATE && TRUE_RATE <= narrow.high ? 1 : 0;
  }
  // Reading the weights as counts gives an interval that misses the truth far more than 1 time in 20.
  assert.ok(coveredAsCounts / TRIALS < 0.9, `as counts: ${coveredAsCounts / TRIALS}`);
  // With effective sizes it errs wide instead.
  assert.ok(covered / TRIALS >= 0.95, `covered ${covered / TRIALS}`);
});

test("auditSample takes some from every band, and its weights undo the over-picking", () => {
  const random = seeded(3);
  // 5% of events are truly yes; the labeler is surer of those.
  const events = Array.from({ length: 6000 }, (_, i) => {
    const truth = random() < 0.05;
    const p = truth ? (random() < 0.8 ? 0.9 + random() * 0.1 : random() * 0.9) : random() < 0.9 ? random() * 0.1 : random() * 0.95;
    return { ...event(`e${i}`, { bug: p }), truth };
  });
  const sample = auditSample(events, { signal: "bug", perBand: 60, random });
  assert.equal(sample.length, 240);
  for (const [from, to] of [[0, 0.1], [0.1, 0.5], [0.5, 0.9], [0.9, 2]]) {
    assert.equal(sample.filter(({ event: e }) => e.signals.bug >= from && e.signals.bug < to).length, 60);
  }
  near(sample.reduce((sum, s) => sum + s.weight, 0), 6000, 1e-6);
  const checked = sample.map(({ event: e, weight }) => ({ id: e.id, signal: "bug", truth: e.truth, weight }));
  const [bug] = agreement(events, checked);
  const whole = agreement(events, events.map((e) => ({ id: e.id, signal: "bug", truth: e.truth })))[0];
  // The weighted sample of 240 estimates what checking all 6,000 would have found.
  near((bug.tp + bug.fn) / 6000, 0.05, 0.02);
  near(bug.recall, whole.recall, 0.15);
  near(bug.specificity, whole.specificity, 0.03);
});

test("compareLabelers counts flips at the gate and how far answers moved", () => {
  const before = [event("a", { bug: 0.9, slow: 0.2 }), event("b", { bug: 0.4, slow: 0.2 }), event("c", { bug: 0.6, slow: 0.7 }), event("only-before", { bug: 1 })];
  const after = [event("a", { bug: 0.8, slow: 0.2 }), event("b", { bug: 0.6, slow: 0.2 }), event("c", { bug: 0.3, slow: 0.7, "bug.second": 1 })];
  const result = compareLabelers(before, after);
  assert.equal(result.events, 3);
  const bug = result.signals.find((s) => s.signal === "bug");
  assert.deepEqual([bug.flips, bug.shareBefore, bug.shareAfter], [2, 2 / 3, 2 / 3]);
  near(bug.meanMove, (0.1 + 0.2 + 0.3) / 3);
  assert.equal(result.signals.find((s) => s.signal === "slow").flips, 0);
  assert.equal(result.signals.some((s) => s.signal === "bug.second"), false);
  near(result.flipRate, 2 / 6);
});
