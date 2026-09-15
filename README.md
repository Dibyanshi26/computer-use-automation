# Computer-Use Automation System

An LLM-driven agent discovers how to complete a goal against a (mock) legacy banking UI, records
what it did as a typed, versioned **capability artifact**, and that artifact is then replayed
**deterministically** — no LLM involved — with structured error handling and a real human-escalation
path. Built for the interface.ai take-home.

**The model discovers. The artifact becomes a reusable capability. Deterministic replay is how an
agent invokes it in production.**

See [REPORT.md](REPORT.md) for the design write-up (architecture, artifact schema, determinism and
error handling, heterogeneity/multi-tenant, escalation, safety, cuts) and
[evidence/README.md](evidence/README.md) for an index of the nine recorded runs.

---

## Quick start

```bash
git clone https://github.com/Dibyanshi26/computer-use-automation.git
cd computer-use-automation
npm install
npx playwright install chromium

# Replay a pre-recorded capability. No API key needed.
npx tsx src/cli.ts replay --capability lookup-member-balance --input memberId=10002
```

Expected output ends with:

```json
{
  "status": "success",
  "outputs": { "checkingBalance": "$500.00", "savingsBalance": "$100.00" },
  "escalated": false
}
```

That single command exercises the production path end to end: it boots the mock target app, logs
in, loads a saved artifact, resolves each step's locators against the live page, verifies the
success checkpoint, and returns typed outputs — with no model in the loop.

**Requirements:** Node 18+ (developed on Node 23), npm. Everything runs on `localhost`; nothing
touches an external network except the OpenAI API, and only during discovery.

---

## Running without live services

The repo ships three pre-recorded capability artifacts in `capabilities/`, so **every replay
command, the full test suite, and the entire escalation and error-handling story work with no API
key and no network access.** Only the two `run` (discovery) commands call the LLM.

| What you want to run | Needs `OPENAI_API_KEY`? |
|---|---|
| `npx tsx src/cli.ts replay ...` (any capability) | No |
| `npm test` (18 tests) | No |
| Browsing the mock app at `localhost:4000` | No |
| `npx tsx src/cli.ts run ...` (discovery) | Yes |

To run discovery yourself:

```bash
cp .env.example .env    # then set OPENAI_API_KEY
# or: export OPENAI_API_KEY=sk-...
```

Optional overrides: `OPENAI_MODEL` (default `gpt-4o`), `MOCK_APP_PORT` (4000),
`CONTROL_SERVER_PORT` (4100). No secrets are committed to this repo.

---

## Demo path

Each command below is self-contained — the mock app starts automatically as a child process if it
isn't already listening, and every run writes a fresh folder to `evidence/`.

Add `--headed` to any command to watch it happen in a real browser window. It's worth doing at
least once for steps 1 and 2 — the speed difference between the LLM figuring it out and the
artifact replaying is the whole point of the project.

### 1. Discovery — a real LLM run that learns a capability from scratch

```bash
npx tsx src/cli.ts run --capability lookup-member-balance --input memberId=10001 --headed
```

Writes `capabilities/lookup-member-balance.v1.0.json` plus an evidence folder with the structured
log, per-step screenshots, and a copy of the artifact. Nothing tells the agent which buttons to
press; it reads the page's accessibility tree and decides each action itself.

A second, richer capability is discovered the same way — a multi-field form with a confirmation
step, deliberately stopping short of the irreversible submit:

```bash
npx tsx src/cli.ts run --capability open-subaccount-discovered \
  --input memberId=10002 --input depositAmount=100 --input nickname="Emergency Fund"
```

`run` is driven by a small spec registry (`src/agent/discoverySpecs.ts`), not a hardcoded goal, so
a spec entry is the only new code a third discoverable capability would need.

### 2. Deterministic replay — same flow, different data, no LLM

```bash
npx tsx src/cli.ts replay --capability lookup-member-balance --input memberId=10002 --headed
```

Member 10002 was never seen during discovery. It works because extract steps are anchored on the
stable row label rather than the balance value that happened to be on screen when recorded.

### 3. A business outcome, not a crash

```bash
npx tsx src/cli.ts replay --capability lookup-member-balance --input memberId=99999
```

Returns `business_outcome: member_not_found`. "No such member" is a legitimate answer the caller
needs, structurally distinct from a failure.

### 4. A multi-field form reaching a confirmation screen

```bash
npx tsx src/cli.ts replay --capability open-subaccount-to-confirmation \
  --input memberId=10002 --input depositAmount=100 --input nickname="Emergency Fund"
```

### 5. Escalation — a human takes control of the live session

```bash
npx tsx src/cli.ts replay --capability open-subaccount-to-confirmation \
  --input memberId=10003 --input depositAmount=100 --input nickname="Emergency Fund" \
  --with-escalation --auto-resume
```

Member 10003 is flagged for manager review, so replay hits an authorization wall it cannot clear
itself. It pauses, raises an intervention with full context, a human acts, and control returns.
The result reports `escalated: true`, so a caller can tell this apart from a clean success.

**To drive the handoff yourself**, drop `--auto-resume` and add `--headed`:

```bash
npx tsx src/cli.ts replay --capability open-subaccount-to-confirmation \
  --input memberId=10003 --input depositAmount=100 --input nickname="Emergency Fund" \
  --with-escalation --headed
```

The browser stops on the supervisor screen and waits. Open **http://localhost:4100** to see the
operator console — which capability, which step, why it stopped, a screenshot, and who currently
holds control. Click "Override (Supervisor)" in the paused browser window yourself, then press
Resume on the console. Automation continues in that same session, and your click is recorded in the
run log as a `human.action` event.

### 6 & 7. Recoverable conditions — handled without a human

```bash
# An unexpected interstitial appears and is dismissed automatically
npx tsx src/cli.ts replay --capability open-subaccount-to-confirmation \
  --input memberId=10002 --input depositAmount=100 --input nickname="Emergency Fund" \
  --inject interstitial

# A transient slow load is waited out and retried
npx tsx src/cli.ts replay --capability open-subaccount-to-confirmation \
  --input memberId=10002 --input depositAmount=100 --input nickname="Emergency Fund" \
  --inject slow
```

### 8. A validation error — also a business outcome

```bash
npx tsx src/cli.ts replay --capability open-subaccount-to-confirmation \
  --input memberId=10002 --input depositAmount=10 --input nickname="Too Small"
```

### Flags

| Flag | Effect |
|---|---|
| `--headed` | Show the browser window instead of running headless |
| `--with-escalation` | Start the mock operator console on `localhost:4100` |
| `--auto-resume` | Scripted stand-in for a human operator, for reproducible evidence |
| `--inject <slow\|interstitial\|timeout>` | Make the target app fail in a controlled way |
| `--capability <id>` | Which capability to run or replay |
| `--input key=value` | Repeatable; values are coerced to the artifact's declared types |

---

## Browsing the target app by hand

Useful for understanding what the automation is actually doing:

```bash
npm run mock-app
```

Then open **http://localhost:4000/login** — any username and password is accepted.

| Path | What it shows |
|---|---|
| Search `10001` → View | Member detail with balances — what the agent reads |
| Search `99999` | "No member found" — the business-outcome page |
| Member 10003 → Open Sub-Account | Supervisor wall — what triggers escalation |
| Member 10002 → Open Sub-Account, deposit `10` | Validation error |
| `/search?inject=interstitial` | The interstitial that recovery dismisses |

Three seeded members (`src/mock-app/data.ts`) cover every path: 10001 is what discovery records
against, 10002 proves replay generalizes to unseen data, and 10003 is flagged so it forces the
escalation branch.

Stop it with `Ctrl+C` before running CLI commands, or they'll collide on port 4000.

---

## Tests

```bash
npm test
```

18 tests, no API key required: schema validation, safety and guardrail units, and replay-engine
integration tests against a real in-process mock app and a real headless browser — success,
business outcome, hard failure, blocklist refusal, risky-action escalation, and both recoverable
paths (dismiss and retry).

---

## What's real vs. deliberately mocked

**Real.** Both discovery runs are genuine GPT-4o agent loops against a live Chromium browser, with
evidence on disk — no scripted steps. Deterministic replay is real and LLM-free. The escalation
pause / cede-control / resume mechanism is real and operates on the same live Playwright session,
with an explicit control-holder state machine and recorded human actions.

**Mocked, on purpose.** The target application (`src/mock-app`) is a local stand-in for a
core-banking teller console, per the brief's instruction not to use a real bank system. It's built
deliberately hostile — server-rendered, table-based layout, no test IDs — to exercise the
"legacy, no clean DOM" reality rather than a clean modern demo site. The operator console
(`src/escalation/controlServer.ts`) is a bare HTML page, not a co-browsing product. For the
escalation evidence run, the human is a scripted stand-in (`--auto-resume`) so the run is
reproducible; it goes through the identical control-transfer path a real operator uses.

See REPORT.md §7 for the full list of deliberate cuts.

---

## Repo layout

```
src/
  mock-app/       target application — server-rendered, table layouts, no test IDs, fault injector
  perception/     accessibility-tree perception (role + accessible name, not raw DOM)
  agent/          LLM client, prompts, discovery loop, action primitives, capability specs, auth
  artifact/       capability artifact schema (zod), recorder, store
  replay/         deterministic replay engine, locator resolution, checkpoints, outcome contract
  safety/         allowlist, risk classifier, redaction
  escalation/     control-transfer state machine + mock operator console
  evidence/       structured run logger
  cli.ts          the run / replay entry point
capabilities/     saved artifacts — two discovery-recorded, one hand-authored
evidence/         nine recorded runs (see evidence/README.md)
tests/            vitest unit + integration tests
```

## Troubleshooting

**`EADDRINUSE` on port 4000 or 4100** — a server from an earlier command is still running:

```bash
pkill -f "tsx src/mock-app"
```

**`Executable doesn't exist` / browser errors** — the Chromium download didn't complete:

```bash
npx playwright install chromium
```

**Discovery fails with an auth error** — `OPENAI_API_KEY` isn't set in the shell running the
command. `echo $OPENAI_API_KEY` to check. Replay and tests don't need it.

**Untracked folders in `evidence/` after running the demos** — expected. Every run writes a fresh
timestamped folder; the committed evidence is the numbered set (`01-` … `09-`). Delete the
timestamped ones freely.
