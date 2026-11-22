// A golden test: replaying both synthetic inboxes raises exactly the alerts on record
// (./data/<set>/expected-alerts.json), monitor for monitor and hour for hour. The record was made
// by the prototype this package grew from, so any change to counting, baselines or episodes that
// moves an alert shows up here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { binomTail, DAY, replay } from "../../src/index.ts";
import { loadInbox } from "./data.ts";
import { supportMonitors } from "./monitors.ts";
import { support } from "./schema.ts";

// The record was made with a binomial approximation in place of Fisher's exact test, fixed
// cutoffs and no minimum baseline. The same three are passed in here, so the runs are comparable.
const recordedCompare = (a, b) => ({ p: binomTail(a.yes + b.yes, a.yes, a.total / (a.total + b.total)) });

for (const name of ["support", "support-holdout"]) {
  test(`${name}: a replay raises exactly the alerts on record`, async () => {
    const inbox = loadInbox(name);
    const monitors = supportMonitors(inbox.events, { minBaseline: 0, compare: recordedCompare }, { page: 1e-5, digest: 1e-4 });
    const from = inbox.start + 8 * DAY;
    const { alerts } = await replay({ monitors, gates: support.gates }, inbox.events, { from, to: inbox.start + inbox.days * DAY });
    const recorded = JSON.parse(readFileSync(new URL(`./data/${name}/expected-alerts.json`, import.meta.url), "utf8")).filter((alert) => alert.at > from);
    const line = (monitor, at) => `${new Date(at).toISOString()} ${monitor}`;
    assert.ok(recorded.length > 10);
    assert.deepEqual(alerts.map((alert) => line(alert.monitor, alert.at)).sort(), recorded.map((alert) => line(alert.monitor, alert.at)).sort());
  });
}
