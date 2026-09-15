# Design Report

## 1. Architecture

Single Node/TypeScript process, no services or queues — the brief explicitly discourages
prematurely building scaling infrastructure, and a CLI is sufficient to demonstrate the two
execution modes (`run` = discovery, `replay` = production path) cleanly.

```
goal + target ─▶ discovery loop (LLM) ─▶ trace ─▶ recorder ─▶ capability artifact (JSON)
                        │                                              │
                   perception layer                              replay engine (no LLM)
                  (accessibility tree)                     locator resolution + checkpoints
                        │                                   + error taxonomy + escalation
                        ▼                                              │
                  Playwright / Chromium ◀─────────────────────────────┘
                        │
                mock legacy banking app (Express, server-rendered, no test IDs)
```

Key decisions:

- **Perception = accessibility tree, not screenshots+coordinates or raw DOM.** `page.ariaSnapshotJSON()`
  gives role+accessible-name for every interactable element. This is deliberately the same
  abstraction a screen reader uses and, on desktop, the same one OS accessibility APIs expose —
  it's the seam that lets discovery/replay logic extend past a browser (§4). It also survives our
  mock app's deliberately ugly markup (nested tables, `<font>` tags, no CSS classes/ids used as
  hooks) because ARIA roles are computed from semantic elements (`<button>`, `<a>`, `<label for>`),
  not from styling.
- **Auth is out-of-band, not part of any capability.** `src/agent/auth.ts` logs in with
  env-provided demo credentials before discovery or replay ever starts operating on a goal. No
  credential enters the LLM conversation, the trace, or the artifact — only the resulting session
  cookie (held by the live `Page`) does.
- **Mock target, not a public site.** A small Express app (`src/mock-app`) simulating a core-banking
  teller console: member search → detail (balances) → open sub-account (multi-field form) →
  confirmation. Server-rendered, table-based layout, zero test IDs — chosen specifically to
  exercise the "legacy, no clean DOM" reality the brief describes, while giving me full control to
  seed the runtime error states real bank software has (record-not-found, validation error,
  an authorization exception) reproducibly, which a public demo site would not let me do safely.

## 2. Artifact schema

`src/artifact/schema.ts` (zod). A capability is a **contract**, not a step list:

- `inputs` / `outputs` — typed parameters the calling agent supplies/receives (JSON-schema-like:
  name, type, required, description).
- `steps[]` — each has an **ordered, ranked list of locators** (not one selector), a
  `riskLevel`, and an optional `checkpoint`.
- `successCheckpoint` — what proves the capability actually reached its goal state.
- `errorHandlers[]` — a small taxonomy (§3) mapping a detectable page condition to one of four
  outcomes.
- `policy` — `maxRiskLevel`, referencing an allowlist config.
- `provenance` — which run produced it and with what model, for auditability.

**Locators are ranked, not singular**, because a legacy app rarely offers one dependable
selector: `[{strategy: "role", role, name}, {strategy: "text", ...}, {strategy: "css", ...}]`.
Replay tries each in order and *logs which one resolved* — that log is the hook a future
drift-detector would use ("this artifact now depends on its 2nd-choice locator") without needing
to fail outright the moment the primary breaks.

One non-obvious problem this schema had to solve: a step that **extracts a value** (a balance)
has an accessible name that *is* the data — it's different every run by definition, so it can
never be a safe locator. The recorder detects this at discovery time and instead anchors on the
row's *label* cell (`"Checking Balance"`, which is stable) and a structural CSS selector
(`tr:has-text("Checking Balance") td:nth-of-type(2)`), keeping the literal-value match only as a
last-resort fallback. This is why `evidence/02-*` (member 10002) succeeds against an artifact
recorded on member 10001 — see `src/agent/actions.ts::computeRowLabelLocatorCss`.

Two `open-subaccount-*` artifacts ship side by side on purpose: `open-subaccount-discovered` is
the direct, unedited output of a real GPT-4o run against the goal in `evidence/09-*` — evidence
that the model can work out a multi-field-form-with-confirmation flow entirely on its own, with no
error taxonomy beyond the generic `member_not_found` baseline every discovery run gets.
`open-subaccount-to-confirmation` is the same capability after a human reviewed the recording and
attached the escalation and recoverable-error handling (§3) it doesn't yet have — record → review
→ promote, the same lifecycle the brief describes for turning a discovery into a production
capability.

## 3. Determinism & error handling

Replay (`src/replay/engine.ts`) never calls the LLM. For each step it: resolves the ranked
locator list against the live page, checks policy (`riskLevel` vs. `policy.maxRiskLevel`),
executes the action, then verifies any `checkpoint`. On any resolution/checkpoint failure, it
consults `errorHandlers` — each one is a `condition` (the same checkpoint vocabulary, e.g.
`textPresent: "No member found"`) paired with an **outcome**:

| Outcome | Meaning | Example |
|---|---|---|
| `business_outcome` | Not a failure — a legitimate, caller-relevant answer | member not found, deposit below minimum |
| `recoverable` | Transient; clear it, then retry the step (bounded per handler by `maxRetries`) | an unexpected interstitial (`recovery: "dismiss"`, clicks a declared `dismissLocator`); a slow load that clears on its own (`recovery: "retry"`, waits then rechecks) |
| `hard_failure` | Genuine dead end; return step/expected/observed + a screenshot | unrecognized page state, no handler matches, or a recoverable handler exhausted its retries |
| `escalate` | Can't safely proceed without a human decision | authorization exception; a risky/irreversible step |

`recoverable` is the one outcome where *how* to recover matters, not just *whether* to: `recovery:
"dismiss"` resolves a declared `dismissLocator` and clicks it (the interstitial's own escape
hatch); `recovery: "retry"` just waits (`src/replay/engine.ts`'s `RECOVERABLE_RETRY_WAIT_MS`) and
re-checks. Each handler tracks its own attempt count against its own `maxRetries` (a
`Map<code, count>` scoped to the current step), so one exhausted handler degrades to a specific,
debuggable `hard_failure` ("condition X did not clear after N retries") rather than a generic
one. `evidence/07-*` and `08-*` exercise dismiss and retry respectively, using a `?inject=` fault
injector built into the mock app (`src/mock-app/app.ts`) specifically so these conditions are
reproducible on demand rather than waiting for a real slow network. One subtlety this surfaced:
condition checks are intentionally short (250ms — "is this true *right now*", not "wait for it to
become true", since the primary locator resolution already did the waiting) and technical
conditions are listed before business-outcome conditions in the artifact's `errorHandlers`, because
a time-sensitive condition (a page that's about to auto-recover) can otherwise slip past its
window while earlier, non-matching handlers are still being checked — see the artifact's
`_errorHandlersComment`.

A **second, independent trigger for escalation** exists outside `errorHandlers`: any step whose
`riskLevel` is `risky` (classified by `src/safety/riskClassifier.ts` from the target's accessible
name — "confirm", "submit", "override", "transfer", …) is *never executed by the automation*, full
stop, regardless of whether it resolves. It escalates on principle. This is deliberate: the
`open-subaccount-to-confirmation` capability's success checkpoint is reaching the confirmation
screen, not submitting it — matching the brief's example goal literally, and meaning our capability
never attempts the irreversible action at all. `tests/engine.test.ts`'s fourth test exercises the
case where a step *is* risky and must be escalated, to prove that path works even though no
evidence run needed it.

Business outcomes and hard failures are deliberately structured differently in the result
contract (`src/replay/outcomes.ts`): a business outcome is `{status, code, message,
screenshotPath}` — clean, cacheable, meant for the calling agent to branch on, with the
screenshot as supporting evidence of the page state the answer came from rather than something
the caller needs to inspect. A hard failure carries `debug: {step, expected, observed,
screenshotPath}` — meant for a human to diagnose, never for the calling agent to parse as if it
were a business answer. Conflating those two is, per the brief, the most common mistake here, so
the type system keeps them structurally distinct rather than relying on a status string
convention. Every handler match — regardless of outcome — captures its screenshot at the moment
of match, before any recovery action or return runs, and every branch downstream reuses that same
capture rather than taking its own (`replay/engine.ts`'s `screenshotLabelForHandler`), so there's
exactly one image per match, not one per branch.

UI drift (secondary, per the brief) is handled by the same ranked-locator/fallback mechanism —
a renamed button breaks the primary `role+name` locator, replay falls back to `text`/`css`, and
the resolved-strategy log line is the drift signal a human would review.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** Not built today, and I want to be precise about that rather than implying
otherwise: `src/perception/accessibilityTree.ts`, `src/agent/actions.ts`, `src/replay/locator.ts`,
`src/replay/checkpoint.ts`, and `src/replay/engine.ts` all `import type { Page } from "playwright"`
and call Playwright APIs directly (`page.ariaSnapshotJSON()`, `page.getByRole`, `page.locator`,
`page.getByText`). There is no `Perception`/`Action` interface anywhere in the codebase for a
second implementation to satisfy. And `LocatorSchema.strategy` (`src/artifact/schema.ts`) is a
**closed** `z.enum(["role", "text", "css"])`, resolved in `resolveStep` (`src/replay/locator.ts`)
by a hardcoded `if/else if` over exactly those three strategies with no default/extension branch —
adding a desktop `"automationId"` strategy would mean editing the zod schema *and* that function,
not just dropping in a new adapter module.

What *would* make it portable, concretely: (1) extract a `Perception` interface —
`perceive(handle): Promise<PerceivedState>` — and an `Action` interface — `click/type/select(handle,
locator)`, `extract(handle, locator)` — and have today's Playwright code become the one implementation
of each, behind a factory keyed by surface type; (2) widen `LocatorSchema.strategy` from the closed
enum to an open `z.string()` (or an enum plus a `z.string()` escape hatch), so a per-adapter strategy
like `"automationId"` is a schema-valid value without a schema *version* bump; (3) make
`resolveStep`/`checkCondition` dispatch to a per-adapter resolver keyed on `strategy` — a small
registry (`Record<string, (handle, locator) => Promise<ResolvedTarget | null>>`) instead of the
current inline `if/else`, so a desktop adapter registers its own `"automationId"` resolver without
touching the Playwright one. Once that seam exists, a desktop `Perception`/`Action` pair backed by
an OS accessibility API (UI Automation on Windows, AXUIElement on macOS) would emit the same
`PerceivedNode` shape the agent loop already consumes, and the artifact schema, error taxonomy,
and escalation model would be genuinely unchanged — but that's a claim about the design being
*reachable* from here in three concrete, scoped edits, not a claim that it's already done.

**Multi-tenant reuse.** `target.app` is already a logical name (`meridian-core-banking`)
decoupled from `target.baseUrl` — the intended shape is one artifact per **vendor-app version**,
with a tenant layer resolving `{app, tenantId} -> {baseUrl, field-label overrides}` before
replay, rather than one artifact per tenant. Concretely, I'd add a `tenant.json` config
(`baseUrl`, plus an override map like `{"Checking Balance": "Chequing Balance"}` for a
differently-branded label) that the replay engine consults when building locators, and keep
`provenance.createdFromRunId` per base artifact so a re-recording is traceable. **Drift
detection**: because each replay already logs which locator strategy resolved, a scheduled
low-stakes replay per tenant (e.g. the read-only `lookup-member-balance`) that starts falling back
to strategy 2/3 instead of strategy 1 is the signal that a tenant's version has drifted from the
base artifact — before it breaks outright. This is described, not built — the brief scopes
multi-tenant implementation out.

## 5. Escalation & handoff

**Detecting stuck**: two independent triggers — (a) an `errorHandlers` entry whose `outcome` is
`escalate` (an authorization exception the app itself signals, e.g. "Supervisor Approval
Required"), and (b) any step classified `risky` exceeding the capability's `policy.maxRiskLevel`
(an irreversible action the automation refuses to take unilaterally). During discovery, the LLM
has a third: it can call `request_help` directly when it doesn't understand the state.

**Taking control of the live session**: the browser runs **headed** by design — the literal
Chromium window the automation drives is the one a human would look at and click into. Nothing is
torn down or handed to a different session across the pause: `ControlServer.requestIntervention()`
(`src/escalation/controlServer.ts`) blocks the *same* `replay()` call on a promise; a bare mock
operator page (`GET /`) polls `/intervention` for context (goal, capability, step, reason,
screenshot) and posts `/resume` when done. Because everything runs in one process, the human's
action and the automation's next action operate on the identical `Page` object — there's no
session re-creation, no cookie hand-off, no state to lose.

**Control-transfer state machine**: exactly two states, `"automation"` and `"human"`
(`ControlServer`'s `ControlState = {holder, who, since}`), live at `GET /control` and rendered on
the operator console. `requestIntervention()` is the only way into `"human"`: it flips the state,
attaches `page.on("framenavigated")` and a `page.on("request")` filter (navigations and POST
requests — form submissions) to the live page, and logs a `control.transferred` event carrying
the new state, the step, and why. `resume()` is the only way back to `"automation"`, and it is a
single choke point both paths go through identically: the real operator console's `POST /resume`
calls it, and so does `--auto-resume`'s scripted stand-in, which performs its click on the live
page and then calls `resume()` itself rather than returning a resolution directly — so its clicks
get exactly the same `human.action` recording a real operator's would, unspecial-cased (see
`evidence/05-*`, whose log shows both transitions and the stand-in's own click recorded as a
human action). `resume()` detaches the listeners *first* — before anything else — so nothing
automation does after resuming can be misattributed as a human action; then it captures a
`post-handoff-<step>` screenshot and the URL the human left the session on, flips the state, and
logs a second `control.transferred` event carrying who resumed, where they left it, and that
screenshot's path.

**Recording what the human did**: while control is held by `"human"`, every `framenavigated` and
every matching `request` on the live page becomes a `human.action` log event (source, URL,
method). This is coarse — it's not a DOM diff or a replay of individual clicks — but it's a real
signal from the actual browser the human (or stand-in) was driving, not a description of intent.

**Handing control back — two distinct resume semantics for the *engine's* control flow**, on top
of the state machine above, matched to the trigger: after an `escalate` error handler (the human
changed page state, e.g. clicked "Override"), the engine **retries the same step** — the control
it needed should now exist. After a risky-action policy block, the engine assumes the human
performed the click themselves live and instead **moves on** to the step's checkpoint — the
automation never re-attempts an irreversible action after a human was just shown it. Both paths
are also logged at the escalation level (`escalation.requested` / `escalation.resumed`, with
`resumedBy`), one layer above the generic `control.transferred` pair, as part of the run's
evidence.

**Scope note**: the operator console is intentionally a single static page with one button, per
the brief's explicit allowance. For the recorded evidence, `--auto-resume` substitutes a scripted
stand-in for the human so runs are reproducible without a person watching a terminal; running
without that flag blocks on a real `POST /resume`, i.e. the actual mechanism, un-scripted.

## 6. Safety

**Allowlist** (`src/config/allowlist.json` + `src/safety/allowlist.ts`): explicit base URLs,
route regex patterns, and permitted action types, enforced on every `navigate` and every
step-level action in both discovery and replay — not just at the UI layer. `assertOriginAllowed`
covers the artifact's own declared target; `assertUrlAllowed` (origin + route) covers each
concrete navigation.

**Risky vs. safe**: `src/safety/riskClassifier.ts` flags an action risky by its target's
accessible name (confirm/submit/override/approve/delete/close/transfer/withdraw) — a legacy app's
buttons are usually named in plain English precisely because there's a human reading them, which
makes this heuristic more reliable here than it would be on an icon-only modern UI. Risky actions
are **blocked, not confirmed-then-run** — see §5, this always routes to a human rather than an
in-band "are you sure?" the LLM could talk itself into.

**Redaction**: `src/safety/redact.ts` deep-redacts any object key matching a secret-name pattern
(`password`, `token`, `ssn`, `cc.?number`, …) before it's written to a log or artifact
(`RunLogger.log`/`finalize` call it on every event). Credentials never reach this path at all
because auth is out-of-band (§1) — the redaction layer is defense for anything *else* sensitive
that ends up in a tool call or extracted value, not the only line of defense for login secrets.

**Limits**: the risk classifier is name-based and English-only; a UI with icon-only risky
controls or a non-English deployment would need a different signal (e.g. an explicit
`data-risk` convention agreed with the app owner, or classifying by HTTP method/mutation on the
underlying request). The allowlist is static config, not policy-as-code — fine at one tenant's
scale, not at hundreds.

## 7. Cuts

- **Multi-tenant and desktop support are designed, not built** (§4), per the brief's explicit
  scope note.
- **`recoverable` (retry/dismiss transient conditions) is now implemented and exercised** (both
  `evidence/07-*` and `08-*`) via a `?inject=` fault injector added to the mock app specifically to
  make these conditions reproducible on demand, since neither shipped flow naturally hits a real
  interstitial or slow load. The injector (`src/mock-app/app.ts`) is opt-in per-request and touches
  no other code path, so uninjected behavior — every existing evidence run and test — is unchanged.
- **Risky-action escalation has no dedicated evidence run** — it's covered by
  `tests/engine.test.ts` instead, to avoid a fourth near-duplicate `evidence/` folder. Given more
  time I'd add it as a recorded run for completeness.
- **Drift detection and confidence scoring** (stretch goals) are designed in §4 but not
  implemented — the ranked-locator resolution log is the primitive a real implementation would
  build on.
- **No agent-facing capability API/catalog** — the CLI (`replay --capability <id> --input k=v`)
  is the invocation surface for this submission; a thin Express/tool-calling wrapper around
  `loadArtifactById` + `replay()` would be a small, natural next step.
- **Next, with more time**: multi-run stability scoring (replay N times, report flakiness);
  a real (non-scripted) operator console with an "act live" affordance instead of a single button;
  canonicalizing recorded values into parameterized patterns automatically instead of via an
  explicit `parameterize` map passed by the caller of `recordArtifact`.

A self-audit against §3 of the brief turned up nine more, smaller things left deliberately cut
rather than silently missing; naming them here rather than leaving them to be found again:
**session-timeout has a fault-injector but no consuming handler** — I'd add a `session_expired`
error handler (`urlMatches: "/login"`) to at least one capability, matching the injector already
built for it. **"Failed load" (as opposed to slow) has neither an injector nor a handler** — I'd
add a `?inject=fail` mode (a 5xx response) and a matching `hard_failure`-vs-`recoverable` handler
pair to distinguish a transient failure from a permanent one. **Native browser dialogs
(`window.confirm`/`alert`/`prompt`) are never listened for** — `page.on("dialog")` isn't registered
anywhere, so one would be silently auto-dismissed by Playwright with no log entry; I'd add a
listener that logs it and treats it like any other unexpected interstitial. **Intermediate tool
calls carry no reasoning field** — only `finish`/`request_help` have a `reason` parameter in
`prompts.ts`; I'd add an optional `reason` to `click`/`type`/`select`/`navigate`/`extract` and log
it, so the structured log captures why, not just what, for every step. **Three of eleven replay
`hard_failure` return sites don't take a screenshot** (input-validation, the origin-guardrail
check, and the mid-step `GuardrailViolation` catch in `engine.ts`) — I'd add `debugSnapshot` calls
at those three. **`auth.ts`'s `login()` bypasses the allowlist** (`page.goto` with no
`assertUrlAllowed` check) — low practical risk since the URL is fixed and env-derived, not
LLM-controlled, but not actually gated; I'd route it through the same check for consistency.
**`schemaVersion` is a bare `z.literal("1.0")` with no dispatch** — a hypothetical 2.0 artifact
just fails `.parse()` with a generic Zod error; I'd check `raw.schemaVersion` before parsing and
throw a specific "unsupported schema version" error as a first step toward real migration support.
**Redaction is keyed on JSON field name, not on what UI field a value came from** — a `type`
action always logs as `{ref, text}`, so a value typed into a live password-*labeled* control
wouldn't be redacted (the key is `text`, not `password`); I'd pass the target element's accessible
name into the log call and redact by that, not just by the argument's own key. **Dead-end/repeated-
state detection in discovery is prompt-only** — `SYSTEM_PROMPT` tells the model to call
`request_help` if the same state repeats, but nothing in `discoveryLoop.ts` actually hashes and
compares consecutive perceived states; I'd add a simple repeat counter as a code-level backstop
for when the model doesn't notice on its own.
