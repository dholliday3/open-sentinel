# Evaluation

Every number here comes from synthetic data: messages a model wrote to a brief, with incidents
planted on known days. None of it is from real customers or real traffic. Where a number comes
from a test, the test is named; the rest say how to rerun them. The replay, false-alarm and
attribution numbers were rerun on 2026-11-22 on Node 24.22.

## The data

- **`examples/support/data/`:** two support inboxes, three weeks each: 4,820 and 4,990
  messages, drawn from about 1,200 distinct messages per inbox. They were written by Claude
  Sonnet 5.5 as the inbox of Acme, a made-up software product for home-service businesses, and
  labeled by `typesafe-ai/jev-1.14.0`. `truth.json` says what was planted and when; monitors
  never see it. The second inbox (the holdout) was written after the monitors' design was set
  on the first, but the per-tag and per-area monitors were added after its first run, so it is
  not fully independent.
- **`examples/customer-messages/data/`:** labels for 390 messages, 338 from customers to a
  home-service business and 52 from its owner to the assistant in their software. Each was
  labeled by Jev 1.14.0 and by Claude Opus 5.5 as the reference a person would otherwise be. The
  messages' text is not included.

The product and its assistant (Remy) were renamed after labeling, in the questions and the
messages alike. No other word changed; `examples/support/schema.test.mjs` holds the wording.

## Detection

`node examples/support/replay.ts` replays both inboxes from day 8 (once a week of baseline
exists) with the default monitors, and the two marketing emails declared as planned changes.
`examples/support/defaults.test.mjs` asserts the outcome: every incident raised, nothing false,
the emails muted, the sharp ones within 2 hours.

| Inbox | Planted | Kind | Raised as | Hours to first alert | First monitor |
|---|---|---|---|---|---|
| main | Google sign-in broken in Android release 4.12.0 | sharp, one platform | page | 1 | 3h share of `area=login_access` |
| main | Invoice PDF adds tax twice; no question names it | about one message an hour | page | 23 | 24h share of `is_bug_report&area=invoices_estimates` |
| main | Reaction to a price increase | slow, over a week | digest | 111 | 3-day share of `frustration>=2&area=billing_plan` |
| main | One business sees another's customers | one message | page | 1 | `event: data_exposure` |
| main | Questions after a launch email | harmless | muted | | |
| main | Look-alikes of a data exposure | harmless | nothing | | |
| holdout | Texts silently not delivered | sharp, everyone | page | 1 | 3h share of `area=texting_calls` |
| holdout | The assistant double-books after a new tool | moderate | digest | 75 | 3-day share of `is_bug_report&area=scheduling_booking` |
| holdout | Payouts arriving days late | slow, over a week | digest | 132 | 3-day share of `is_bug_report&area=payments_payouts` |
| holdout | iOS 4.13.0 crashes when adding photos | sharp, one version | page | 2 | 3h share of `is_bug_report&area=other` |
| holdout | Questions after a webinar email | harmless | muted | | |
| holdout | Account taken over by an outsider | one message | page | 1 | `event: data_exposure` |
| holdout | Look-alikes of a takeover | harmless | nothing | | |

No alert on either inbox had nothing planted behind it. Without the emails declared as planned,
each email raised a page within an hour; every incident was still raised, and nothing false.

Counting baselines in whole stretches (2026-11-22) moved the three digest items. The price and
payout digests came 1 and 10 hours sooner. The double-booking digest came 20 hours later than
its earlier 55, though at 39 hours when the webinar isn't declared: the webinar's two planned
days end 2 days and 8 hours before the 3-day window that would have caught it, too short for a
whole 3-day stretch, so the baseline reaches back past them to older weeks.

`examples/support/replay.test.mjs` is a golden test: with the comparison and fixed cutoffs of the
prototype this package grew from passed in, a replay raises exactly the alerts on record,
monitor for monitor and hour for hour. The record is the prototype's, except that counting
baselines in whole stretches moved its 3-day digest alerts by 1 to 11 hours, each still behind
the same planted item, and added one behind the iOS photo crash.

## False alarms

`node examples/support/budget.ts` takes the main inbox with every planted item removed (4,531
messages) and shuffles which answers arrived when, so any alert is false. 20 shuffles of 1.86
weeks each, 37 weeks in all:

| | Per week | Budget |
|---|---|---|
| False pages | 0.027 | 0.25 |
| False digest items | 0.081 | 1 |

`node examples/support/budget.ts 10 repeats` does the same with customers who write more than
once: three in ten arrivals are followed by one to four more from the same customer. 10
shuffles, 19 weeks:

| Counted | False pages a week | False digest items a week |
|---|---|---|
| Per customer (the default) | 0 | 0.162 |
| Per message | 8.99 (36 times the budget) | 2.26 |

## Attribution

`examples/support/suspects.test.mjs` adds six unrelated deploys a day at random times and asks
`suspectsFor` about each incident's first alert, 40 times:

- The release behind each of the two release-caused incidents (Android sign-in, iOS photo
  crash) was the confident first suspect in 40 of 40 draws.
- The invoice bug's deploy had no scope, so only timing could point to it. It came first in 14
  of 40 draws and was never called confident. The test asserts no confident wrong answer and
  between 8 and 20 right.

Every planted cause shipped within 2 hours of its incident, which flatters timing.

## Labels and quality checks

`examples/customer-messages/gates.test.mjs` runs the quality checks on the 390 labeled messages,
with Claude Opus 5.5 standing in for a person:

- `fitGates` finds the same best gate for all 12 yes/no questions that an earlier study of these
  labels found with separate code. The gates range from 0.3 to 0.9, and agreement beyond chance
  (kappa) at those gates from 0.76 to 1.
- `calibration` gives the same table: of 3,484 checked answers, the 439 at 0.9 or above were
  right 99% of the time; those between 0.7 and 0.8, 53%. Expected calibration error 0.043, Brier
  score 0.034.

`src/quality.test.mjs` checks `correctedRate` on 400 simulated streams: its 95% interval covered
the true rate 93% to 97.5% of the time. On a weighted sample it errs wide, where reading the
weights as counts covered the truth less than 90% of the time.

## Interoperability and packaging

- **OTLP.** The exporter's output loads and round-trips as an `ExportLogsServiceRequest` under
  OpenTelemetry's own message definitions (`src/sinks/otlp.test.mjs`). No real backend has
  received it.
- **MCP.** The official MCP client connects to `bin/mcp.ts`, lists its tools and calls them
  (`src/mcp.test.mjs`).
- **The README's first example** runs end to end with the gateway's reply stubbed
  (`examples/readme.test.mjs`).
- **Installing from git.** Checked by hand on 2026-11-21, not by a test: installing a local
  clone as a git dependency built `dist/` through the `prepare` script, the package imported,
  and `open-sentinel-mcp` answered. npm 11.19 warned about the install script and ran it;
  npm 12.2 needed `--allow-git=root`. Not yet checked against the GitHub repository itself.

The OTLP and MCP-client tests check against two dev dependencies. Without `npm ci` they are
skipped, and say so.

## Live run against real models

`node examples/support/live.ts` calls real models through the Vercel AI Gateway (Jev for labels,
Claude Haiku 5.5 as the second reader, Claude Sonnet 5.5 as the investigator). It needs
`AI_GATEWAY_API_KEY` and costs about 10 cents. Recorded from its last run, on 2026-11-21:

- **Pipeline:** 7 events labeled for $0.00044. Answers within 0.12 of those on file from the
  same model. A redelivery was skipped at no cost.
- **Second reader:** asked about the two answers in its band, and said no to both.
- **Backtest:** a question nobody had asked ("does the invoice their customer received show a
  different total?") over a week of history, 1,640 messages, for $0.025. It said yes 44 times:
  44 of the planted bug's 45 messages and nothing else, all from the day the bug shipped.
- **Investigation:** given the page for that bug, the investigator named the deploy that caused
  it, the right start time and that the app's own totals were correct, in 2 rounds of tool
  calls for $0.07.

## From the prototype study

open-sentinel grew from a prototype tested on the same synthetic data; its code is not in this
repository. These numbers come from it, are all synthetic, and were not rerun on this package.

**Small volume.** A simpler weekly rule (at least 3 complaints, and that many less than 1%
likely at the rate of the 6 weeks before), simulated 2,000 times per volume with a 5% complaint
rate that either stays or doubles:

| Messages a week | False alarms | Doubling caught: Jev at 0.5 / Jev at 0.7 / perfect labels |
|---|---|---|
| 8 | 0 to 1% | 2% / 1% / 2% |
| 25 | 0 to 1% | 5% / 6% / 7% |
| 100 | 1% | 16% / 25% / 33% |

The gap between Jev and perfect labels is label noise. The gap between perfect labels and 100%
is volume, and it is most of it.

**Cost per 1,000 messages,** 12 questions each, on the 390-message sample:

| Labeler | Cost | p50 latency |
|---|---|---|
| Jev 1.14.0, one request | $0.033 | 135 ms |
| Claude Haiku 5.5 | $0.29 | 2.1 s |
| Claude Opus 5.5 | $10.21 | 3.3 s |

On the support inboxes, labeling every message and investigating every page came to about
$0.15 per 1,000 conversations.

**Stability.** The same 100 messages labeled twice: Jev changed 0.4% of its answers, Claude Haiku
at temperature 0 changed 1.3%. Recomputing last month should give last month's numbers.

**Investigator.** On 16 pages and digest items across both inboxes, the prototype's investigator
gave the right verdict (incident or harmless) 16 times and the right cause 15 times, graded by
an LLM judge that saw what was planted.

**Exposure on a flag rollout.** With the invoice bug shipped behind a flag to 10%, 20% and 50% of
customers, an exposed-versus-unexposed monitor caught it in 5%, 10% and 24% of 100 runs. Once a
regular monitor had fired, exposure put the flag first about 80% of the time, against 15% by
timing alone. Exposure is better at naming a change than at catching one.
