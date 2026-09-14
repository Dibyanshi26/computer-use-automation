# Evidence

Each directory is one run: `log.json` (structured event log), `summary.json` (final outcome),
`screenshots/` (per-step captures; hard-failure/escalation runs also get a labeled failure
screenshot), and — for the discovery run only — `artifact.json` (the capability recorded from
that run, also saved to `/capabilities`).

| Run | Type | What it shows |
|---|---|---|
| [01-discovery-lookup-member-balance](01-discovery-lookup-member-balance) | **Real LLM discovery run** (GPT-4o) | The agent is given only the goal "look up member 10001 and read their current checking and savings balance" and a start URL. It perceives the accessibility tree, decides its own actions (search, open detail, extract x2, finish) with no scripted steps, and produces `capabilities/lookup-member-balance.v1.0.json`. |
| [02-replay-lookup-member-balance-success](02-replay-lookup-member-balance-success) | Deterministic replay — success | Same artifact, replayed with **member 10002** (never seen during discovery) with the LLM out of the loop entirely. Succeeds because extract steps use a structural, label-anchored locator rather than the literal balance text recorded during discovery (see REPORT.md, Determinism & error handling). |
| [03-replay-lookup-member-balance-not-found](03-replay-lookup-member-balance-not-found) | Deterministic replay — business outcome | Member `99999` does not exist. Reported as `business_outcome: member_not_found`, not a crash. |
| [04-replay-open-subaccount-success](04-replay-open-subaccount-success) | Deterministic replay — success | Hand-authored multi-field-form-with-confirmation capability (search → detail → open sub-account → fill form → reach confirmation screen), replayed straight through for a non-flagged member. |
| [05-replay-open-subaccount-escalation-supervisor-override](05-replay-open-subaccount-escalation-supervisor-override) | Deterministic replay — **human escalation** | Member `10003` is flagged for manager review. Replay can't resolve the expected form controls (a "Supervisor Approval Required" interstitial is shown instead), matches the `escalate` error handler, pauses, and raises an intervention on the mock operator console. A human (scripted stand-in here, see README.md "What's scripted") takes over the **same live browser session**, clicks "Override (Supervisor)", and resumes — the run then continues and reaches the confirmation screen. |
| [06-replay-open-subaccount-invalid-deposit](06-replay-open-subaccount-invalid-deposit) | Deterministic replay — business outcome | Deposit amount ($10) is below the app's minimum. Reported as `business_outcome: invalid_deposit_amount`, distinct from `member_not_found` — both are legitimate answers, not failures. |
| [07-replay-recoverable-interstitial](07-replay-recoverable-interstitial) | Deterministic replay — **recoverable (dismiss)** | Run with `--inject interstitial` (see `src/mock-app/app.ts`'s `?inject=` fault injector): an unexpected "Session Notice" page appears in place of the intended one. The `session_notice_interstitial` handler (`recovery: "dismiss"`) matches, clicks the page's own "Dismiss" control, and retries the step — all without a human. |
| [08-replay-recoverable-slow-load](08-replay-recoverable-slow-load) | Deterministic replay — **recoverable (retry)** | Run with `--inject slow`: the intended page is delayed behind a ~4s "Please wait" interstitial that clears on its own. The `slow_load` handler (`recovery: "retry"`, `maxRetries: 2`) matches, waits, and retries — succeeding once the underlying page has finished loading. |

Additionally, `tests/engine.test.ts` covers a sixth outcome not captured as a standalone evidence
run: a **risky/irreversible action being policy-blocked and escalated** (the automation never
clicks "Confirm & Open Account" itself; a human does, live, during the handoff). See REPORT.md,
Cuts, for why that's a test rather than a recorded run.

**Reproducing 07/08**: `npx tsx src/cli.ts replay --capability open-subaccount-to-confirmation --input memberId=10002 --input depositAmount=100 --input nickname="Emergency Fund" --inject interstitial` (or `--inject slow`). `--inject` attaches `?inject=<mode>` to the capability's first navigate step; every route in the mock app honors it identically, so this works against any capability, not just this one.
