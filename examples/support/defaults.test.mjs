// The SDK's defaults on both inboxes: cutoffs from the alarm budget, a minimum baseline, and the
// two launch emails declared as planned changes. Every planted incident must be raised, nothing
// else, and the emails' own spikes must stay quiet.
import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "./replay.ts";

const expected = {
  support: { paged: ["android_signin", "invoice_pdf_total", "data_exposure"], digest: ["price_change"], muted: ["booking_launch"], quick: ["android_signin", "data_exposure"] },
  "support-holdout": { paged: ["texts_failing", "ios_photo_crash", "account_takeover"], digest: ["assistant_double_booking", "payout_delays"], muted: ["webinar_questions"], quick: ["texts_failing", "ios_photo_crash", "account_takeover"] },
};

for (const [name, want] of Object.entries(expected)) {
  test(`${name}: every incident raised, nothing false, planned spikes muted`, async () => {
    const { scored } = await run(name, { planned: true });
    const how = Object.fromEntries(scored.items.map((item) => [item.id, item.as]));
    for (const id of want.paged) {
      assert.equal(how[id], "page", id);
    }
    for (const id of want.digest) {
      assert.equal(how[id], "digest", id);
    }
    for (const id of want.muted) {
      assert.equal(how[id], "muted", id);
    }
    for (const id of want.quick) {
      assert.ok(scored.items.find((item) => item.id === id).hours <= 2, `${id} took ${scored.items.find((item) => item.id === id).hours} hours`);
    }
    assert.deepEqual(scored.falseGroups.map((group) => group.alerts.map((alert) => alert.monitor)), []);
    // The look-alikes of a data exposure (their own old customers, a spouse's login) raised nothing.
    assert.equal(scored.items.filter((item) => item.id.endsWith("_decoy")).every((item) => item.as === "none"), true);
  });
}
