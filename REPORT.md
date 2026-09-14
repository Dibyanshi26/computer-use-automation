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

## 3. Determinism & error handling

Replay (`src/replay/engine.ts`) never calls the LLM. For each step it: resolves the ranked
locator list against the live page, checks policy (`riskLevel` vs. `policy.maxRiskLevel`),
executes the action, then verifies any `checkpoint`. On any resolution/checkpoint failure, it
consults `errorHandlers` — each one is a `condition` (the same checkpoint vocabulary, e.g.
`textPresent: "No member found"`) paired with an **outcome**:

| Outcome | Meaning | Example |
|---|---|---|
| `business_outcome` | Not a failure — a legitimate, caller-relevant answer | member not found, deposit below minimum |
| `recoverable` | Transient; retry (bounded) | not exercised by name in this build (see Cuts) but wired identically to `escalate`'s retry path |
| `hard_failure` | Genuine dead end; return step/expected/observed + a screenshot | unrecognized page state, no handler matches |
| `escalate` | Can't safely proceed without a human decision | authorization exception; a risky/irreversible step |

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
contract (`src/replay/outcomes.ts`): a business outcome is `{status, code, message}` — clean,
cacheable, meant for the calling agent to branch on. A hard failure carries `debug: {step,
expected, observed, screenshotPath}` — meant for a human to diagnose, never for the calling agent
to parse as if it were a business answer. Conflating those two is, per the brief, the most common
mistake here, so the type system keeps them structurally distinct rather than relying on a status
string convention.

UI drift (secondary, per the brief) is handled by the same ranked-locator/fallback mechanism —
a renamed button breaks the primary `role+name` locator, replay falls back to `text`/`css`, and
the resolved-strategy log line is the drift signal a human would review.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is already drawn at `perceive()`
(`src/perception/accessibilityTree.ts`, returning `{role, name, ref}` nodes) and the four
`act*()` primitives in `src/agent/actions.ts`. Neither the discovery loop, the artifact schema,
nor the replay engine know Playwright exists — they operate on `PerceivedNode`/`Locator`/action
verbs. A **legacy web app** needs no new abstraction at all (that's what the mock app already is).
A **desktop app** would mean a new `Perception`/`Action` implementation backed by an OS
accessibility API (UI Automation on Windows, AXUIElement on macOS) instead of Playwright, emitting
the same `PerceivedNode` shape and a `Locator` variant like `{strategy: "automationId"}` alongside
the existing `role`/`text`/`css` ones — everything above that line (agent loop, artifact schema,
replay engine, error taxonomy, escalation) is unchanged. That's the actual test of whether the
abstraction is right: the replay engine's `resolveStep` already treats "locator strategy" as an
open, ranked list, not a closed enum tied to a browser.

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

**Handing control back**: two distinct resume semantics, matched to the trigger: after an
`escalate` error handler (the human changed page state, e.g. clicked "Override"), the engine
**retries the same step** — the control it needed should now exist. After a risky-action policy
block, the engine assumes the human performed the click themselves live and instead **moves on**
to the step's checkpoint — the automation never re-attempts an irreversible action after a human
was just shown it. Both paths are logged (`escalation.requested` / `escalation.resumed`, with
`resumedBy`) as part of the run's evidence.

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
- **`recoverable` (retry/dismiss transient conditions)** is implemented in the engine's control
  flow but no error handler in either shipped capability uses it — both example flows didn't
  produce a natural transient-load case worth faking. The retry loop and its `maxRetries` plumbing
  are real and covered by the same code path `escalate` uses.
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
