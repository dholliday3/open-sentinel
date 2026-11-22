# Contributing

open-sentinel is pre-1.0. Issues and pull requests are welcome. For anything larger than a fix,
open an issue first so we can agree on the shape.

## Setup

You need Node 22.18 or later. The package has no runtime dependencies; `npm ci` installs the
dev tools (TypeScript, Node's types, and two packages the tests check output against) and builds
`dist/` through the `prepare` script.

```bash
npm ci
npm run type-check   # tsc over src/, examples/ and bin/
npm test             # every test; under a minute, no network
npm run build        # JavaScript and type declarations in dist/
```

CI runs the same four steps on Node 22 and 24 (`.github/workflows/ci.yml`).

The tests and examples run the TypeScript in `src/` directly, which Node does for files outside
`node_modules`. An installed copy uses `dist/`. The OTLP and MCP-client tests need the dev
dependencies; without them they are skipped and say so.

## The example replays

The examples run on synthetic data in `examples/`, already labeled, so they need no model calls.
[docs/evaluation.md](docs/evaluation.md) describes the data and the results.

```bash
node examples/support/replay.ts                # both inboxes with the default monitors
node examples/support/budget.ts                # false alerts on shuffled, incident-free data
node examples/support/budget.ts 10 repeats     # the same, with customers who write more than once
node examples/support/live.ts                  # real models; needs AI_GATEWAY_API_KEY, about 10 cents
```

- `replay.ts` replays each inbox from day 8 (once a week of baseline exists) to day 21, one tick
  an hour, and scores every alert against `truth.json`: which planted item is behind it, how it
  arrived (page, digest, muted) and how many hours after the item began. Monitors never see the
  truth.
- `budget.ts` removes every planted item from the main inbox, shuffles which answers arrived
  when, and counts the alerts that still fire. Each one is false.
- Three tests hold these results: `defaults.test.mjs` (every incident raised, nothing false),
  `replay.test.mjs` (a golden record of exact alerts) and `suspects.test.mjs` (attribution). A
  change to counting, baselines or episodes that moves an alert shows up there.

## Changing things

- **Code style.** Match the code around you. It is strict TypeScript that Node can run as is
  (`erasableSyntaxOnly`: no enums, namespaces or parameter properties).
- **Tests.** Add a test for what can break: a refusal, an edge case, a failure path. Tests are
  `.test.mjs` files beside the code, run by `node --test`.
- **A new store** runs the shared store tests: add it to the list in `src/store.test.mjs`.
- **README and docs snippets** have type-checked counterparts in `examples/readme.ts`. Change both.
  `examples/readme.test.mjs` runs the README's first example.
- **Numbers in the docs** need a source: a test, a script in `examples/`, or a recorded run. Say
  when they come from synthetic data.
- **The example data** must stay synthetic. Don't add real messages.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
