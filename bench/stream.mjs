// The synthetic support stream the benchmark runs on: 17 days (the default monitors' lookback)
// at a given volume a week, 21 signals, a customer on every message, two tags, sixty unrelated
// deploys and one release that breaks something in the last three hours.
const src = process.env.SENTINEL_SRC ?? new URL("../src/", import.meta.url).pathname;
const { both, choice, DAY, defineSchema, eventMonitor, HOUR, score, shareMonitors, volumeMonitor, yesNo } = await import(`${src}index.ts`);
const { seeded } = await import(`${src}testing.ts`);

export const AREAS = ["login", "billing", "payments", "invoices", "scheduling", "website", "google", "texting", "assistant", "other"];
export const schema = defineSchema({
  name: "support",
  questions: {
    area: choice("Which area?", Object.fromEntries(AREAS.map((area) => [area, area]))),
    is_bug_report: yesNo("bug?"),
    blocked: yesNo("blocked?"),
    how_to: yesNo("how to?"),
    feature_request: yesNo("feature?"),
    price_complaint: yesNo("price?"),
    churn_intent: yesNo("churn?"),
    data_exposure: yesNo("exposure?"),
    praise: yesNo("praise?"),
    frustration: score("frustrated?", ["no", "little", "clearly", "furious"]),
  },
});
export const NOW = Date.UTC(2026, 10, 22, 12);
export const DAYS = 17;
const VERSIONS = ["4.10.0", "4.11.0", "4.12.0"];

/** The stream, oldest first, in batches: built as it is read, so a database can be filled without holding it all. */
export function* batches({ perWeek, size = 2000, seed = 7 }) {
  const random = seeded(seed);
  const perHour = perWeek / (7 * 24);
  const accounts = Math.max(500, Math.round(perWeek / 4));
  let n = 0;
  let batch = [];
  for (let hour = 0; hour < DAYS * 24; hour += 1) {
    const from = NOW - DAYS * DAY + hour * HOUR;
    const spiking = hour >= DAYS * 24 - 3;
    // A whole number an hour on average, spread over the hour in time order.
    const count = Math.floor(perHour * (hour + 1)) - Math.floor(perHour * hour);
    const times = Array.from({ length: count }, () => from + Math.floor(random() * HOUR)).sort((a, b) => a - b);
    for (const at of times) {
      const area = AREAS[Math.floor(random() * AREAS.length)];
      const version = VERSIONS[Math.floor(random() * 3)];
      const p = (share) => (random() < share ? 0.95 : 0.02);
      const signals = Object.fromEntries(AREAS.map((a) => [`area=${a}`, a === area ? 0.95 : 0.01]));
      Object.assign(signals, {
        is_bug_report: p(spiking && version === "4.12.0" ? 0.5 : 0.15),
        blocked: p(0.05),
        how_to: p(0.3),
        feature_request: p(0.05),
        price_complaint: p(0.03),
        churn_intent: p(0.02),
        data_exposure: p(0.0005),
        praise: p(0.05),
        "frustration>=1": p(0.4),
        "frustration>=2": p(0.15),
        "frustration>=3": p(0.03),
      });
      batch.push({ id: `m${n}`, at, text: `I tried to send invoice ${n} to my customer and the total was different from the app`, unit: `acct-${Math.floor(random() * accounts)}`, tags: { version, platform: random() < 0.5 ? "ios" : "android" }, schema: schema.id, labeler: "jev@1", probability: "native", signals });
      n += 1;
      if (batch.length >= size) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length > 0) {
    yield batch;
  }
}

export const changes = () => {
  const random = seeded(99);
  const deploys = [];
  for (let day = 0; day < 10; day += 1) {
    for (let k = 0; k < 6; k += 1) {
      deploys.push({ id: `deploy-${day}-${k}`, at: NOW - (day + 1) * DAY + Math.floor(random() * DAY), kind: "deploy", what: `web deploy ${day}-${k}` });
    }
  }
  return [...deploys, { id: "release-4.12.0", at: NOW - 4 * HOUR, kind: "release", what: "4.12.0", scope: { version: "4.12.0" } }];
};

/** 125 monitors: every signal at three windows, bug reports and frustration per area, volume, one-event leaks. */
export const monitors = () => [
  ...shareMonitors({ signals: schema.signals }),
  ...shareMonitors({ signals: both(["is_bug_report", "frustration>=2"], AREAS.map((area) => `area=${area}`)) }),
  volumeMonitor({ windowMs: 3 * HOUR }),
  eventMonitor({ signal: "data_exposure" }),
];
