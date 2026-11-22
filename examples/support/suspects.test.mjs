// Change attribution on the two synthetic inboxes, with the SDK's own ranking. A mobile release
// reaches only the events written on that app version, so the two incidents a release caused can
// be tied to it by exposure: the release must come out first, confidently, however many
// unrelated deploys share the day. The incidents with no scoped change are ranked by time alone,
// and must never be a confident wrong answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY, HOUR, suspectsFor, viewOf } from "../../src/index.ts";
import { seeded } from "../../src/testing.ts";
import { run } from "./replay.ts";
import { plantedBehind } from "./score.ts";
import { support } from "./schema.ts";

const CAUSE = { android_signin: /^mobile 4\.12\.0/, ios_photo_crash: /^mobile 4\.13\.0/ };
const OTHER_DEPLOYS_A_DAY = 6;
const DRAWS = 40;

for (const [name, incident] of [["support", "android_signin"], ["support-holdout", "ios_photo_crash"]]) {
  test(`${name}: the release behind ${incident} is the confident first suspect among ${OTHER_DEPLOYS_A_DAY} other deploys a day`, async () => {
    const { inbox, scored } = await run(name, { planned: true });
    const first = scored.items.find((item) => item.id === incident).first;
    // The ranking sees only what had happened when the alert fired.
    const view = viewOf(inbox.events.filter((event) => event.at < first.at));
    const random = seeded(5);
    const results = [];
    for (let draw = 0; draw < DRAWS; draw += 1) {
      const decoys = Array.from({ length: inbox.days * OTHER_DEPLOYS_A_DAY }, (_, i) => ({ id: `decoy-${i}`, at: inbox.start + Math.floor(i / OTHER_DEPLOYS_A_DAY) * DAY + Math.floor(random() * 10 * HOUR), kind: "deploy", what: `unrelated deploy ${i}` }));
      const found = suspectsFor(first, view, [...inbox.changes, ...decoys], { gates: support.gates });
      results.push({ top: found.ranked[0].change.what, confident: found.confident, exposure: found.ranked[0].exposure });
    }
    assert.equal(results.filter((result) => CAUSE[incident].test(result.top) && result.confident).length, DRAWS, JSON.stringify(results.find((result) => !CAUSE[incident].test(result.top) || !result.confident)));
    // The exposed events rose against the rest and against events like them before the release.
    assert.ok(results[0].exposure.rise.evidence > 2 && results[0].exposure.contrast.evidence > 2);
  });
}

test("support: an incident with no scoped change is never pinned confidently on the wrong deploy", async () => {
  const { inbox, scored } = await run("support", { planned: false });
  const first = scored.items.find((item) => item.id === "invoice_pdf_total").first;
  const view = viewOf(inbox.events.filter((event) => event.at < first.at));
  const random = seeded(6);
  let right = 0;
  for (let draw = 0; draw < DRAWS; draw += 1) {
    const decoys = Array.from({ length: inbox.days * OTHER_DEPLOYS_A_DAY }, (_, i) => ({ id: `decoy-${i}`, at: inbox.start + Math.floor(i / OTHER_DEPLOYS_A_DAY) * DAY + Math.floor(random() * 10 * HOUR), kind: "deploy", what: `unrelated deploy ${i}` }));
    const found = suspectsFor(first, view, [...inbox.changes, ...decoys], { gates: support.gates });
    const isCause = /^api: invoice PDF renderer v2/.test(found.ranked[0].change.what);
    assert.ok(isCause || !found.confident, `confidently blamed "${found.ranked[0].change.what}"`);
    right += isCause ? 1 : 0;
  }
  // By time alone, with six other deploys a day, the true cause is first about a third of the time.
  assert.ok(right >= 8 && right <= 20, `first in ${right} of ${DRAWS}`);
  assert.deepEqual(plantedBehind(first, inbox), ["invoice_pdf_total"]);
});
