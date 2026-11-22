// The quality checks on labels from real models. 390 synthetic messages (./data/labels.jsonl)
// were labeled twice: by Jev 1.14.0, a decision model, and by Claude Opus 5.5 as the reference a
// person would otherwise be. An earlier study worked out each question's best cutoff and the
// calibration table from those labels with separate code. The SDK's checks must give the same
// numbers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calibration, fitGates } from "../../src/index.ts";
import { customer, owner } from "./schema.ts";

const schemas = { customer, owner };
const rows = readFileSync(new URL("./data/labels.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const labeled = [];
const audit = [];
for (const row of rows) {
  const schema = schemas[row.writtenBy];
  labeled.push({ id: row.id, at: 0, schema: schema.id, labeler: "typesafe-ai/jev-1.14.0", probability: "native", signals: schema.read(row.jev) });
  for (const [key, question] of Object.entries(schema.questions)) {
    if (question.type === "boolean") {
      audit.push({ id: row.id, signal: key, truth: row.reference[key] === true || row.reference[key] === "true" });
    }
  }
}

test("fitGates finds the recorded best gate for every yes/no question", () => {
  const { fitted } = fitGates(labeled, audit);
  const found = Object.fromEntries(fitted.map((f) => [f.signal, [f.gate, Number(f.kappa.toFixed(2))]]));
  assert.deepEqual(found, {
    asks_for_work: [0.8, 0.76],
    asks_price: [0.3, 0.97],
    complaint: [0.6, 0.93],
    work_problem: [0.8, 0.97],
    payment_dispute: [0.3, 0.92],
    price_objection: [0.9, 0.95],
    safety_or_damage: [0.6, 0.93],
    legal_threat: [0.3, 0.94],
    praise: [0.8, 0.77],
    stop_texting: [0.3, 1],
    frustrated_with_assistant: [0.4, 1],
    churn_risk: [0.3, 1],
  });
});

test("calibration gives the recorded table: sure answers are right, the middle runs high", () => {
  const { rows, ece, brier } = calibration(labeled, audit);
  assert.equal(rows.reduce((sum, row) => sum + row.checked, 0), 3484);
  assert.equal(ece.toFixed(3), "0.043");
  assert.equal(brier.toFixed(3), "0.034");
  const top = rows.at(-1);
  assert.equal(top.checked, 439);
  assert.equal(Math.round(top.observedYes * 100), 99);
  assert.equal(Math.round(rows[7].observedYes * 100), 53);
});
