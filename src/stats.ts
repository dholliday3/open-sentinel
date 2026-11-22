// The statistics every monitor and check shares. Pure functions, no state.

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0. */
export const logGamma = (x: number): number => {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const shifted = x - 1;
  let sum = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i += 1) {
    sum += LANCZOS[i]! / (shifted + i);
  }
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
};

const logChoose = (n: number, k: number): number => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

/** P(X ≥ k) for X ~ Binomial(n, p). Sums the smaller tail from its largest term, so large n is safe. */
export const binomTail = (n: number, k: number, p: number): number => {
  if (k <= 0) {
    return 1;
  }
  if (k > n) {
    return 0;
  }
  const rate = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  const odds = rate / (1 - rate);
  const pmf = (i: number): number => Math.exp(logChoose(n, i) + i * Math.log(rate) + (n - i) * Math.log1p(-rate));
  if (k > n * rate) {
    let term = pmf(k);
    let sum = term;
    for (let i = k; i < n && term > sum * 1e-17; i += 1) {
      term *= ((n - i) / (i + 1)) * odds;
      sum += term;
    }
    return Math.min(1, sum);
  }
  let term = pmf(k - 1);
  let below = term;
  for (let i = k - 1; i > 0 && term > below * 1e-17; i -= 1) {
    term *= i / (n - i + 1) / odds;
    below += term;
  }
  return Math.max(0, 1 - below);
};

/** Log-likelihood of k yeses in n at the best-fitting rate. */
export const logLik = (k: number, n: number): number => (n === 0 || k === 0 || k === n ? 0 : k * Math.log(k / n) + (n - k) * Math.log(1 - k / n));

export interface Counts {
  yes: number;
  total: number;
}

/**
 * P(X ≥ k) when X counts the yeses among `draws` events taken from `population` events that hold
 * `yeses` in all (the hypergeometric tail). Sums the smaller tail from its largest term.
 */
export const hyperTail = (population: number, yeses: number, draws: number, k: number): number => {
  const low = Math.max(0, draws - (population - yeses));
  const high = Math.min(yeses, draws);
  if (k <= low) {
    return 1;
  }
  if (k > high) {
    return 0;
  }
  const pmf = (i: number): number => Math.exp(logChoose(yeses, i) + logChoose(population - yeses, draws - i) - logChoose(population, draws));
  /** pmf(i + 1) / pmf(i). */
  const step = (i: number): number => ((yeses - i) * (draws - i)) / ((i + 1) * (population - yeses - draws + i + 1));
  if (k > (draws * yeses) / population) {
    let term = pmf(k);
    let sum = term;
    for (let i = k; i < high && term > sum * 1e-17; i += 1) {
      term *= step(i);
      sum += term;
    }
    return Math.min(1, sum);
  }
  let term = pmf(k - 1);
  let below = term;
  for (let i = k - 1; i > low && term > below * 1e-17; i -= 1) {
    term /= step(i - 1);
    below += term;
  }
  return Math.max(0, 1 - below);
};

/**
 * Two groups of events, one question: is yes more common in `a` than chance allows? Fisher's
 * exact test, one-sided: of all the yeses in both groups, how likely is it that at least this
 * many fell in `a`. Neither group's rate is treated as known, and it holds for common signals as
 * well as rare ones. `evidence` is the log-likelihood gain of "the rates differ", negative when
 * `a` is not higher.
 */
export const compareRates = (a: Counts, b: Counts): { p: number; evidence: number } => {
  const total = a.total + b.total;
  const p = total === 0 ? 1 : hyperTail(total, a.yes + b.yes, a.total, a.yes);
  const gain = logLik(a.yes, a.total) + logLik(b.yes, b.total) - logLik(a.yes + b.yes, total);
  const higher = a.total > 0 && b.total > 0 && a.yes / a.total > b.yes / b.total;
  return { p, evidence: higher ? gain : -gain };
};

/** Wilson score interval for a share. */
export const wilson = (yes: number, total: number, z = 1.96): { low: number; high: number } => {
  if (total === 0) {
    return { low: 0, high: 1 };
  }
  const share = yes / total;
  const denom = 1 + (z * z) / total;
  const mid = (share + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((share * (1 - share)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: Math.max(0, mid - half), high: Math.min(1, mid + half) };
};

/**
 * The per-check cutoff that keeps expected false alerts within a weekly budget: the budget split
 * evenly over every check every monitor makes in a week. It holds however the checks overlap or
 * the signals correlate with each other. It does not hold when the things being counted aren't
 * independent, which is why monitors count customers, not messages, when events carry a `unit`.
 */
export const alphaFor = ({ perWeek, checksPerWeek, monitors }: { perWeek: number; checksPerWeek: number; monitors: number }): number =>
  monitors === 0 ? 1 : perWeek / (checksPerWeek * monitors);
