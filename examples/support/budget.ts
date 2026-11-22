// Does the alarm budget hold? Take the main inbox with every planted item removed, then shuffle
// which message arrived when, so nothing in it is a real shift. Any alert is false. The budget
// says to expect at most 0.25 pages and 1 digest item a week from chance.
//
//   node examples/support/budget.ts [shuffles]
//   node examples/support/budget.ts [shuffles] repeats
//
// With `repeats`, customers write more than once: three in ten arrivals are followed by one to
// four more from the same customer saying the same thing. The messages are then no longer
// independent, and the run counts false alerts both ways: per message and per customer.
import { DAY, replay, WEEK } from "../../src/index.ts";
import type { LabeledEvent } from "../../src/index.ts";
import { seeded } from "../../src/testing.ts";
import { loadInbox } from "./data.ts";
import { supportMonitors } from "./monitors.ts";
import { support } from "./schema.ts";

const inbox = loadInbox("support");
const planted = new Set(inbox.planted.map((item) => item.id));
const background = inbox.events.filter((event) => !planted.has(inbox.sourceOf.get(event.id)!));
const shuffles = Number(process.argv[2] ?? 20);
const repeats = process.argv[3] === "repeats";
const random = seeded(11);
const from = inbox.start + 8 * DAY;
const to = inbox.start + inbox.days * DAY;
const weeks = (to - from) / WEEK;

/** Gives each arrival a customer. Some customers send the next few arrivals too, with the same answers. */
const withRepeats = (events: readonly LabeledEvent[]): LabeledEvent[] => {
  const out: LabeledEvent[] = [];
  for (let i = 0; i < events.length; ) {
    const first = events[i]!;
    const more = random() < 0.3 ? 1 + Math.floor(random() * 4) : 0;
    for (let k = 0; k <= more && i < events.length; k += 1, i += 1) {
      out.push({ ...events[i]!, unit: `customer-${first.id}`, signals: first.signals });
    }
  }
  return out;
};

const counts = { "per customer": { page: 0, digest: 0 }, "per message": { page: 0, digest: 0 } };
for (let s = 0; s < shuffles; s += 1) {
  const order = background.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  // Each arrival keeps its time and tags and gets another message's answers.
  const shuffled = background.map((event, i) => ({ ...event, signals: background[order[i]!]!.signals }));
  const events = repeats ? withRepeats(shuffled) : shuffled;
  // Without customers on the events both ways count the same thing, so one run is enough.
  for (const per of repeats ? (["unit", "event"] as const) : (["unit"] as const)) {
    const { groups } = await replay({ monitors: supportMonitors(events, { per }), gates: support.gates }, events, { from, to });
    const tally = counts[per === "unit" ? "per customer" : "per message"];
    tally.page += groups.filter((group) => group.severity === "page").length;
    tally.digest += groups.filter((group) => group.severity === "digest").length;
    for (const group of groups) {
      console.log(`  shuffle ${s + 1}${repeats ? `, counted ${per === "unit" ? "per customer" : "per message"}` : ""}: ${group.severity} ${group.alerts.map((alert) => `${alert.monitor} (${String(alert.detail.now ?? "")} vs ${String(alert.detail.baseline ?? "")})`).join("; ")}`);
    }
  }
}
console.log(`${shuffles} shuffles of ${background.length} events, ${weeks.toFixed(2)} weeks each${repeats ? ", with customers who write more than once" : ""}.`);
for (const [how, tally] of Object.entries(counts)) {
  if (repeats || how === "per customer") {
    console.log(`${repeats ? `Counted ${how}: f` : "F"}alse pages per week: ${(tally.page / shuffles / weeks).toFixed(3)} (budget 0.25). False digest items per week: ${(tally.digest / shuffles / weeks).toFixed(3)} (budget 1).`);
  }
}
