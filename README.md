# Computer-Use Automation System

An LLM-driven agent discovers how to complete a goal against a real (mock) legacy banking UI,
records what it did as a typed, versioned **capability artifact**, and that artifact is then
replayed **deterministically** — no LLM involved — with structured error handling and a real
human-escalation path. Built for the interface.ai take-home (see the brief for full context).

See [REPORT.md](REPORT.md) for the design write-up (architecture, artifact schema, determinism,
heterogeneity/multi-tenant story, escalation model, safety model, and cuts) and
[evidence/README.md](evidence/README.md) for an index of the recorded runs.

## What's real vs. mocked

- **Real**: the discovery run is a genuine GPT-4o-driven agent loop against a live, headless/headed
  Chromium browser — no scripted steps. Deterministic replay is real (no LLM). The escalation
  pause/resume/control-transfer mechanism is real and operates on the same live Playwright
  session.
- **Mocked, deliberately**: the target application (`src/mock-app`) is a small local stand-in for
  a core-banking UI, not a real bank system, per the brief's instructions. The operator console
  (`src/escalation/controlServer.ts`) is a bare HTML page, not a full co-browsing product. For the
  escalation evidence runs, the "human" who clicks Resume/Override is a scripted stand-in
  (`--auto-resume` flag) so the runs are reproducible without a person watching a terminal — see
  REPORT.md, *Escalation & handoff*, for how a real operator would use the same mechanism
  interactively instead.

## Setup

Requires Node 18+.

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then set OPENAI_API_KEY (or export it in your shell)
```

`OPENAI_API_KEY` is required for the discovery run only — replay never calls the LLM. The mock
app is started automatically by the CLI (as a child process) if it isn't already running; it never
touches a real network beyond `localhost`.

## Demo path

```bash
# 1. Discovery: a real LLM run that learns a capability from scratch.
npx tsx src/cli.ts run --memberId 10001
#   -> writes capabilities/lookup-member-balance.v1.0.json
#   -> writes evidence/discovery-<ts>/ (log, screenshots, artifact copy)

# 2. Deterministic replay of that artifact, with a DIFFERENT member than it was recorded on,
#    and with no LLM in the loop.
npx tsx src/cli.ts replay --capability lookup-member-balance --input memberId=10002

# 3. Replay hitting a legitimate business outcome (not a crash) instead of success.
npx tsx src/cli.ts replay --capability lookup-member-balance --input memberId=99999

# 4. Replay of a hand-authored, richer capability (multi-field form -> confirmation screen).
npx tsx src/cli.ts replay --capability open-subaccount-to-confirmation \
  --input memberId=10002 --input depositAmount=100 --input nickname="Emergency Fund"

# 5. Replay that hits a state the artifact can't safely resolve on its own -> escalates to a
#    human, who takes control of the SAME live browser session, then hands control back.
npx tsx src/cli.ts replay --capability open-subaccount-to-confirmation \
  --input memberId=10003 --input depositAmount=100 --input nickname="Emergency Fund" \
  --with-escalation --auto-resume
#   with --with-escalation (no --auto-resume), the mock operator console is served at
#   http://localhost:4100 and the run blocks until a real person clicks Resume there.
```

Useful flags: `--headed` (show the browser), `--with-escalation` (start the mock operator
console), `--auto-resume` (scripted stand-in for a human operator, for reproducible evidence).

## Tests

```bash
npm test
```

Runs schema validation, safety/guardrail unit tests, and replay-engine integration tests
(success, business outcome, hard failure, and risky-action escalation) against a real, in-process
instance of the mock app and a real headless browser.

## Repo layout

```
src/
  mock-app/        legacy-style target application (server-rendered, table layouts, no test IDs)
  perception/       accessibility-tree perception layer
  agent/            LLM client, prompts, discovery loop, action primitives, auth
  artifact/         capability artifact schema, recorder, store
  replay/           deterministic replay engine, locator resolution, checkpoints, outcomes
  safety/           allowlist, risk classifier, redaction
  escalation/        human handoff control server + mock operator console
  evidence/         structured run logger
capabilities/       saved capability artifacts (one discovery-recorded, one hand-authored)
evidence/           recorded discovery + replay runs (see evidence/README.md)
tests/              vitest unit + integration tests
```
