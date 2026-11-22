// Replays both synthetic support inboxes through the SDK with its defaults and prints what was
// caught. No model calls: the inboxes are already labeled.
//
//   node examples/support/replay.ts
import { DAY, replay } from "../../src/index.ts";
import type { Change } from "../../src/index.ts";
import { loadInbox } from "./data.ts";
import type { Inbox, InboxName } from "./data.ts";
import { supportMonitors } from "./monitors.ts";
import { support } from "./schema.ts";
import { score } from "./score.ts";
import type { Scored } from "./score.ts";

/**
 * The two emails to every customer, declared the way a team would before sending them: questions
 * about the topic are expected for two days, and so is more volume.
 */
const PLANNED: Array<{ what: RegExp; signals: string[] }> = [
  { what: /online booking launch email/, signals: ["area=scheduling_booking", "how_to", "*"] },
  { what: /Google Business Profile webinar/, signals: ["area=google_profile", "how_to", "praise", "*"] },
];
export const withPlans = (changes: readonly Change[]): Change[] =>
  changes.map((change) => {
    const plan = PLANNED.find((p) => p.what.test(change.what));
    return plan ? { ...change, expect: { signals: plan.signals, forMs: 2 * DAY } } : change;
  });

/** One replay from day 8 (once a week of baseline exists) to the end, with the SDK's defaults. */
export const run = async (name: InboxName, { planned }: { planned: boolean }): Promise<{ inbox: Inbox; scored: Scored; pages: number; digests: number }> => {
  const inbox = loadInbox(name);
  const { alerts, groups } = await replay({ monitors: supportMonitors(inbox.events), gates: support.gates }, inbox.events, {
    from: inbox.start + 8 * DAY,
    to: inbox.start + inbox.days * DAY,
    changes: planned ? withPlans(inbox.changes) : inbox.changes,
  });
  return { inbox, scored: score(inbox, alerts, groups), pages: groups.filter((g) => g.severity === "page").length, digests: groups.filter((g) => g.severity === "digest").length };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const name of ["support", "support-holdout"] as const) {
    for (const planned of [false, true]) {
      const { scored, pages, digests } = await run(name, { planned });
      console.log(`\n${name}${planned ? ", launch emails declared as planned changes" : ""}: ${pages} pages, ${digests} digest items, ${scored.falseGroups.length} with nothing planted behind them`);
      for (const item of scored.items) {
        console.log(`  ${item.id.padEnd(20)} ${item.kind.padEnd(9)} ${item.as.padEnd(7)} ${item.hours === null ? "" : `${item.hours} h`.padEnd(6)} ${item.first?.monitor ?? ""}`);
      }
      for (const group of scored.falseGroups) {
        console.log(`  FALSE ${group.id}: ${group.alerts.map((alert) => alert.monitor).join("; ")}`);
      }
    }
  }
}
