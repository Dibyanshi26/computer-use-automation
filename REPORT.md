# Design Report

## 1. Architecture

Single Node/TypeScript process, no services or queues — the brief discourages premature scaling
infrastructure, and a CLI cleanly demonstrates the two execution modes (`run` = discovery,
`replay` = production path).

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

- **Perception = accessibility tree, not screenshots or raw DOM.** `page.ariaSnapshotJSON()` gives
  role+accessible-name for every element — the same abstraction a screen reader uses, and the seam
  that lets discovery/replay extend past a browser (§4). It survives the mock app's ugly markup
  (nested tables, `<font>` tags, no CSS hooks) because ARIA roles come from semantic elements
  (`<button>`, `<a>`, `<label for>`), not from styling.
- **Auth is out-of-band, not part of any capability.** `src/agent/auth.ts` logs in with env
  credentials before discovery or replay ever touches a goal. No credential enters the LLM
  conversation, the trace, or the artifact — only the resulting session cookie does.
- **Mock target, not a public site.** `src/mock-app`: member search → detail → open sub-account →
  confirmation, server-rendered, table-based, zero test IDs — exercises "legacy, no clean DOM"
  while letting me seed runtime errors (not-found, validation, authorization) reproducibly, which a
  public demo site wouldn't allow.

## 2. Artifact schema

`src/artifact/schema.ts` (zod). A capability is a **contract**, not a step list:

- `inputs`/`outputs` — typed, named, described parameters the calling agent supplies/receives.
- `steps[]` — each has a **ranked list of locators** (not one selector), a `riskLevel`, an optional
  `checkpoint`.
- `successCheckpoint` — proof the capability actually reached its goal state.
- `errorHandlers[]` — a taxonomy (§3) mapping a detectable condition to one of four outcomes.
- `policy` — `maxRiskLevel`, referencing an allowlist.
- `provenance` — which run produced it, with what model.

Locators are ranked because a legacy app rarely offers one dependable selector. Replay tries each
in order and logs which one resolved — the hook a future drift-detector would use.

One non-obvious problem: an **extract** step's accessible name *is* the data, so it can never be a
safe locator (a different member has a different balance). The recorder anchors on the row's
stable *label* cell instead (`tr:has-text("Checking Balance"):not(:has(table)) td:nth-of-type(2)`),
keeping the literal-value match only as a last resort — why `evidence/02-*` (member 10002)
succeeds against an artifact recorded on member 10001.

Two `open-subaccount-*` artifacts ship side by side on purpose: `open-subaccount-discovered` is
the unedited output of a real GPT-4o run (`evidence/09-*`) — evidence that the model can learn a
multi-field-form-with-confirmation flow on its own, with only the generic `member_not_found`
baseline every discovery gets. `open-subaccount-to-confirmation` is the same capability after a
human reviewed the recording and attached the escalation/recoverable-error handling it doesn't yet
have — record → review → promote, the lifecycle the brief describes for turning a discovery into a
production capability.

## 3. Determinism & error handling

Replay (`src/replay/engine.ts`) never calls the LLM. For each step it resolves the ranked locator
list, checks policy (`riskLevel` vs. `maxRiskLevel`), executes, then verifies any `checkpoint`. On
failure it consults `errorHandlers` — a `condition` paired with an outcome:

| Outcome | Meaning | Example |
|---|---|---|
| `business_outcome` | Not a failure — a legitimate, caller-relevant answer | member not found, deposit below minimum |
| `recoverable` | Transient; clear it, then retry (bounded per handler by `maxRetries`) | an interstitial (`recovery: "dismiss"`, clicks a `dismissLocator`); a slow load (`recovery: "retry"`, waits then rechecks) |
| `hard_failure` | Genuine dead end; step/expected/observed + a screenshot | unrecognized state, no handler matches, or retries exhausted |
| `escalate` | Can't safely proceed without a human | authorization exception; a risky/irreversible step |

`recoverable`'s *how* matters, not just whether: `"dismiss"` clicks a declared `dismissLocator`;
`"retry"` waits and rechecks. Each handler tracks its own attempt count, so an exhausted one
degrades to a specific `hard_failure` ("condition X did not clear after N retries"), exercised in
`evidence/07-*`/`08-*` via a `?inject=` fault injector built into the mock app. Condition checks are
deliberately short (250ms, "is this true *right now*"), and technical conditions are listed before
business-outcome ones in each artifact — otherwise a time-sensitive condition (a page about to
auto-recover) can slip past its window while earlier handlers are still being checked.

A second, independent escalation trigger sits outside `errorHandlers`: any `risky`-named step
(confirm/submit/override/transfer, …) is never executed by automation, full stop. This is why
`open-subaccount-to-confirmation`'s checkpoint is *reaching* the confirmation screen, not submitting
it — the capability never attempts the irreversible action, and a dedicated test proves the
escalation path itself still fires correctly.

Business outcomes and hard failures are structurally distinct: `{status, code, message,
screenshotPath}` for the calling agent to branch on, vs. `debug: {step, expected, observed,
screenshotPath}` for a human to diagnose. Conflating the two is, per the brief, the most common
mistake here, so the type system enforces the split rather than a status-string convention. Every
handler match captures one screenshot at the moment of match, reused downstream rather than
retaken.

UI drift (secondary, per the brief) is caught by the same fallback mechanism — a renamed button
breaks the primary locator, replay falls back to text/css, and the resolved-strategy log line is
the drift signal a human reviews.

## 4. Heterogeneity & multi-tenant

**Surface abstraction — not built today.** `accessibilityTree.ts`, `actions.ts`, `locator.ts`,
`checkpoint.ts`, and `engine.ts` all import and call Playwright directly; there's no
`Perception`/`Action` interface anywhere. `LocatorSchema.strategy` is a **closed**
`z.enum(["role","text","css"])`, resolved by a hardcoded `if/else` with no extension point —
adding a desktop `"automationId"` strategy would mean editing the schema *and* that function.

What would make it portable, concretely: (1) extract `Perception`/`Action` interfaces and make
today's Playwright code their one implementation, behind a factory keyed by surface type; (2)
widen `strategy` from the closed enum to an open string, so a new adapter strategy is schema-valid
without a schema-version bump; (3) replace the inline `if/else` with a per-strategy resolver
registry. Once that seam exists, a desktop pair backed by an OS accessibility API (UI Automation /
AXUIElement) would emit the same `PerceivedNode` shape the agent loop already consumes — reachable
in three scoped edits, not already done.

**Multi-tenant reuse.** `target.app` is already decoupled from `target.baseUrl` — the intended
shape is one artifact per vendor-app version, with a tenant layer resolving `{app, tenantId} ->
{baseUrl, field-label overrides}` before replay, rather than one artifact per tenant. I'd add a
`tenant.json` (base URL + a label-override map, e.g. `{"Checking Balance": "Chequing Balance"}`)
the replay engine consults when building locators. **Drift detection**: since each replay logs
which locator strategy resolved, a scheduled low-stakes replay per tenant that starts falling back
to strategy 2/3 is the signal a tenant has drifted — before it breaks outright. Described, not
built — the brief scopes multi-tenant implementation out.

## 5. Escalation & handoff

**Detecting stuck**: two triggers — an `errorHandlers` entry with outcome `escalate` (an
authorization exception the app signals, e.g. "Supervisor Approval Required"), or any `risky` step
exceeding policy. Discovery has a third: the LLM can call `request_help` directly.

**Taking control, and the state machine behind it**: the browser runs **headed** by design — the
window a human would click into is the one automation drives, nothing torn down across the pause.
Control is tracked as one of two explicit states, `"automation"`/`"human"` (`ControlState =
{holder, who, since}`), live at `GET /control` and rendered on the operator console.
`ControlServer.requestIntervention()` is the only way into `"human"`: it blocks the same `replay()`
call on a promise, attaches `framenavigated`/`request` listeners to the live page, and logs a
`control.transferred` event. `resume()` is the only way back, and every path goes through it
identically — the real console's `POST /resume`, and `--auto-resume`'s scripted stand-in, which
clicks on the live page and then calls `resume()` itself rather than short-circuiting, so its
actions get the same `human.action` recording a real operator's would (`evidence/05-*`). `resume()`
detaches the listeners *first* so nothing automation does afterward is misattributed, then captures
a `post-handoff-<step>` screenshot and the URL the human left, flips the state, and logs the
transition. Every navigation and matching POST request while control is held by `"human"` becomes
a `human.action` event — coarse, not a DOM diff, but a real signal from the browser being driven.

**Handing control back**: two resume semantics matched to the trigger. After `escalate`, the engine
retries the same step. After a risky-action policy block, it moves on to the checkpoint instead —
automation never re-attempts an irreversible action after a human was just shown it.

**Scope note**: the operator console is a single static page with one button, per the brief's
explicit allowance; without `--auto-resume`, replay blocks on a real `POST /resume`.

## 6. Safety

**Allowlist** (`src/config/allowlist.json` + `src/safety/allowlist.ts`): explicit base URLs, route
patterns, and permitted action types, enforced on every navigate and step-level action in both
discovery and replay — including a live re-check (`isBlockedByName`) of the resolved element's
name before executing click/type/select in replay, independent of whatever `riskLevel` the
artifact declares.

**Risky vs. safe**: `riskClassifier.ts` flags an action by its target's accessible name
(confirm/submit/override/delete/transfer/…) — legacy buttons are usually named in plain English,
which makes this more reliable here than on an icon-only modern UI. Risky actions are **blocked,
not confirmed-then-run** — always routed to a human, never an in-band "are you sure?" the LLM
could talk itself into.

**Redaction**: `redact.ts` deep-redacts any key matching a secret pattern before it's written to a
log, artifact, or console — applied on every write path (`RunLogger.log`/`finalize`/
`writeArtifactCopy`, `store.ts::saveArtifact`). Credentials never reach this path at all since auth
is out-of-band (§1); redaction is defense for anything else sensitive.

**Limits**: the risk classifier is name-based and English-only — icon-only controls or a
non-English deployment would need a different signal. The allowlist is static config, not
policy-as-code — fine at one tenant's scale, not hundreds. Redaction is keyed on JSON field name,
not on which UI field a value came from (§7).

## 7. Cuts

- Multi-tenant and desktop support are designed, not built (§4), per the brief's scope note.
- `recoverable` (dismiss/retry) is exercised (`evidence/07-*`/`08-*`) via a `?inject=` fault
  injector, since neither shipped flow naturally hits a real interstitial or slow load.
- Risky-action escalation has no dedicated evidence run — covered by `tests/engine.test.ts` instead
  of a fourth near-duplicate folder.
- Drift detection and confidence scoring (stretch goals) are designed in §4, not implemented.
- No agent-facing capability API/catalog — the CLI is this submission's invocation surface; a thin
  tool-calling wrapper around `loadArtifactById` + `replay()` is the natural next step.

A self-audit against brief §3 turned up nine smaller gaps, cut deliberately rather than missed
silently — one line each on what I'd do:

- **Session timeout** has a fault-injector but no consuming handler → add a `session_expired`
  handler that matches it.
- **"Failed load"** (vs. slow) has neither injector nor handler → add `?inject=fail` (a 5xx) and a
  matching handler.
- **Native dialogs** (`window.confirm`/etc.) go unlistened-for and are silently auto-dismissed →
  add a `page.on("dialog")` listener that logs and treats it like any other interstitial.
- **Intermediate tool calls carry no reasoning field** (only `finish`/`request_help` do) → add an
  optional `reason` to the rest and log it.
- **3 of 11 `hard_failure` sites skip the screenshot** (input-validation, origin-guardrail,
  mid-step `GuardrailViolation`) → add `debugSnapshot` calls there.
- **`auth.ts::login()` bypasses the allowlist** (low risk — fixed, env-derived URL — but not
  gated) → route it through the same check.
- **`schemaVersion` is a bare literal with no dispatch** — a 2.0 artifact just fails `.parse()`
  with a generic error → check the version first and throw something specific.
- **Redaction is keyed on JSON field name, not UI-field semantics** — a `type` action always logs
  `{ref, text}`, so a password-*labeled* field's value wouldn't be redacted → redact by the target
  element's name too.
- **Dead-end/repeated-state detection is prompt-only**, not code-enforced → add a code-level
  repeat counter as a backstop.

**Next, with more time**: multi-run stability scoring; a real (non-scripted) operator console;
automatic canonicalization of recorded values into parameterized patterns instead of the explicit
`parameterize` map a caller passes today.
