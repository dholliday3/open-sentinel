import assert from "node:assert/strict";
import { test } from "node:test";
import { alphaFor, binomTail, compareRates, hyperTail, logGamma, wilson } from "./stats.ts";

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} is not ${expected}`);

/** P(X >= k) by summing every term: slow, obviously right. */
const exactTail = (n, k, p) => {
  let sum = 0;
  for (let i = k; i <= n; i += 1) {
    sum += Math.exp(logGamma(n + 1) - logGamma(i + 1) - logGamma(n - i + 1) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return sum;
};

test("logGamma matches factorials", () => {
  close(logGamma(1), 0);
  close(logGamma(5), Math.log(24));
  close(logGamma(11), Math.log(3628800));
  close(logGamma(0.5), Math.log(Math.sqrt(Math.PI)));
});

test("binomTail gives known values", () => {
  close(binomTail(10, 3, 0.5), 968 / 1024);
  close(binomTail(10, 10, 0.5), 1 / 1024);
  close(binomTail(4, 1, 0.25), 1 - 0.75 ** 4);
  assert.equal(binomTail(10, 0, 0.3), 1);
  assert.equal(binomTail(10, 11, 0.3), 0);
});

test("binomTail agrees with a term-by-term sum on both sides of the mean", () => {
  for (const [n, p] of [[40, 0.1], [200, 0.03], [500, 0.5], [1200, 0.137]]) {
    for (const k of [1, Math.floor(n * p), Math.ceil(n * p) + 1, Math.ceil(n * p * 2), n]) {
      const expected = exactTail(n, k, p);
      assert.ok(Math.abs(binomTail(n, k, p) - expected) <= 1e-9 + expected * 1e-7, `n=${n} k=${k} p=${p}: ${binomTail(n, k, p)} vs ${expected}`);
    }
  }
});

test("binomTail stays a probability and falls as k rises, at large n", () => {
  let last = 1;
  for (let k = 0; k <= 100_000; k += 2500) {
    const tail = binomTail(100_000, k, 0.2);
    assert.ok(tail >= 0 && tail <= 1 && tail <= last + 1e-12, `k=${k}: ${tail}`);
    last = tail;
  }
  assert.ok(binomTail(100_000, 20_500, 0.2) < 1e-4);
  assert.ok(binomTail(100_000, 19_500, 0.2) > 0.999);
});

test("hyperTail gives Fisher's exact values and agrees with a term-by-term sum", () => {
  // The lady tasting tea: 8 cups, 4 with milk first, she picks 4; all 4 right has probability 1/70.
  close(hyperTail(8, 4, 4, 4), 1 / 70);
  close(hyperTail(8, 4, 4, 3), 17 / 70);
  assert.equal(hyperTail(8, 4, 4, 0), 1);
  assert.equal(hyperTail(8, 4, 4, 5), 0);
  // When every non-yes is drawn, some yeses must be: the lowest possible count is certain.
  assert.equal(hyperTail(10, 6, 7, 3), 1);
  const logChoose = (n, k) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  for (const [population, yeses, draws] of [[60, 36, 30], [500, 40, 120], [3000, 900, 700], [2000, 15, 200]]) {
    for (const k of [1, Math.floor((draws * yeses) / population), Math.ceil((draws * yeses) / population) + 2, Math.min(yeses, draws)]) {
      let expected = 0;
      // Counts below this can't happen: there aren't enough non-yeses to fill the draw.
      const lowest = Math.max(0, draws - (population - yeses));
      for (let i = Math.max(k, lowest); i <= Math.min(yeses, draws); i += 1) {
        expected += Math.exp(logChoose(yeses, i) + logChoose(population - yeses, draws - i) - logChoose(population, draws));
      }
      assert.ok(Math.abs(hyperTail(population, yeses, draws, k) - expected) <= 1e-9 + expected * 1e-6, `${population} ${yeses} ${draws} ${k}: ${hyperTail(population, yeses, draws, k)} vs ${expected}`);
    }
  }
});

test("compareRates has power for common signals, not only rare ones", () => {
  // Half of 30 against seven tenths of 30. A binomial stand-in for this test calls it p = 0.2.
  const common = compareRates({ yes: 21, total: 30 }, { yes: 15, total: 30 });
  assert.ok(common.p < 0.1 && common.p > 0.05, `p = ${common.p}`);
  assert.ok(compareRates({ yes: 140, total: 200 }, { yes: 500, total: 1000 }).p < 1e-6);
});

test("compareRates: a higher rate in the first group gives a small p and positive evidence", () => {
  const up = compareRates({ yes: 30, total: 100 }, { yes: 50, total: 1000 });
  assert.ok(up.p < 1e-9 && up.evidence > 10);
  const same = compareRates({ yes: 5, total: 100 }, { yes: 50, total: 1000 });
  assert.ok(same.p > 0.4 && Math.abs(same.evidence) < 0.01);
  const down = compareRates({ yes: 1, total: 100 }, { yes: 100, total: 1000 });
  assert.ok(down.p > 0.99 && down.evidence < -3);
  assert.equal(compareRates({ yes: 0, total: 0 }, { yes: 0, total: 0 }).p, 1);
});

test("compareRates doesn't treat a small baseline as exact", () => {
  // 10% against a baseline of 5%: clear with a large baseline, not with a tiny one.
  assert.ok(compareRates({ yes: 20, total: 200 }, { yes: 500, total: 10_000 }).p < 0.005);
  assert.ok(compareRates({ yes: 20, total: 200 }, { yes: 2, total: 40 }).p > 0.1);
});

test("wilson brackets the share and stays in range", () => {
  const { low, high } = wilson(5, 100);
  assert.ok(low > 0.015 && low < 0.05 && high > 0.05 && high < 0.12);
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
  assert.equal(wilson(0, 50).low, 0);
});

test("alphaFor spreads the weekly budget over every check", () => {
  close(alphaFor({ perWeek: 0.25, checksPerWeek: 168, monitors: 100 }), 0.25 / 16800);
  assert.equal(alphaFor({ perWeek: 1, checksPerWeek: 168, monitors: 0 }), 1);
});
