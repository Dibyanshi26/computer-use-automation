import "dotenv/config";
import { chromium } from "playwright";
import { runDiscovery } from "./agent/discoveryLoop.js";
import { login } from "./agent/auth.js";
import { recordArtifact } from "./artifact/recorder.js";
import { saveArtifact, loadArtifactById, loadArtifact } from "./artifact/store.js";
import { replay } from "./replay/engine.js";
import { RunLogger } from "./evidence/logger.js";
import { ensureMockAppRunning, stopMockApp } from "./mock-app/ensureRunning.js";
import { ControlServer, type InterventionRequest, type ResumeSignal } from "./escalation/controlServer.js";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = `http://localhost:${process.env.MOCK_APP_PORT ?? 4000}`;
const EVIDENCE_DIR = path.join(process.cwd(), "evidence");

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean>; inputs: Record<string, unknown> } {
  const flags: Record<string, string | boolean> = {};
  const inputs: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") {
      const kv = argv[++i];
      const [k, ...rest] = kv.split("=");
      inputs[k] = rest.join("="); // coerced to the artifact's declared input type in cmdReplay
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, inputs };
}

async function cmdRun(flags: Record<string, string | boolean>) {
  const memberId = String(flags.memberId ?? "10001");
  await ensureMockAppRunning(BASE_URL);

  const browser = await chromium.launch({ headless: !flags.headed });
  const page = await browser.newPage();
  const runId = `discovery-${Date.now()}`;
  const logger = new RunLogger(EVIDENCE_DIR, runId);

  try {
    logger.log("run.start", { capability: "lookup-member-balance", memberId, baseUrl: BASE_URL });
    await login(page, BASE_URL);
    logger.log("auth.login_complete", {});

    const goal =
      `Look up member ${memberId} and read their current checking and savings balance. ` +
      `Search using the member id field on /search, open the matching member's detail page, ` +
      `then call extract twice: once with outputName "checkingBalance" for the checking balance value, ` +
      `and once with outputName "savingsBalance" for the savings balance value. Then call finish with ` +
      `success=true and outputs containing both values. If no member is found, call finish with ` +
      `success=true and an outputs field "businessOutcome" describing that, since that is a legitimate result.`;

    const result = await runDiscovery(page, { goal, startUrl: `${BASE_URL}/search`, maxSteps: 20 }, logger);
    logger.log("run.discovery_result", result as unknown as Record<string, unknown>);

    if (!result.success) {
      logger.finalize({ status: "failed", stopReason: result.stopReason, escalated: result.escalated });
      console.error(`Discovery did not complete successfully: ${result.stopReason}`);
      process.exitCode = 1;
      return;
    }

    const outputNames = Object.keys(result.outputs).filter((k) => k !== "businessOutcome");
    const artifact = recordArtifact(result, {
      id: "lookup-member-balance",
      name: "Look Up Member Balance",
      version: "1.0",
      description: "Search for a member by ID and read their current checking and savings balance.",
      app: "meridian-core-banking",
      baseUrl: BASE_URL,
      runId,
      discoveredBy: process.env.OPENAI_MODEL ?? "gpt-4o",
      parameterize: { [memberId]: "memberId" },
      inputs: [{ name: "memberId", type: "string", required: true, description: "Member ID to search for." }],
      outputs: outputNames.map((name) => ({ name, type: "string", description: `Extracted value for ${name}.` })),
      successCheckpoint: { type: "textPresent", text: "Checking Balance" },
      errorHandlers: [
        {
          code: "member_not_found",
          message: "No member found for the given search.",
          condition: { type: "textPresent", text: "No member found" },
          outcome: "business_outcome",
          recovery: "none",
          maxRetries: 0,
        },
      ],
    });

    const savedPath = saveArtifact(artifact);
    logger.writeArtifactCopy(artifact);
    logger.finalize({ status: "success", outputs: result.outputs, artifactPath: savedPath });
    console.log(`Discovery succeeded. Artifact saved to ${savedPath}`);
    console.log(`Evidence written to ${logger.runDir}`);
  } finally {
    await browser.close();
    stopMockApp();
  }
}

async function cmdReplay(flags: Record<string, string | boolean>, inputs: Record<string, unknown>) {
  const capabilityId = String(flags.capability ?? "lookup-member-balance");
  await ensureMockAppRunning(BASE_URL);

  const artifact = flags.file ? loadArtifact(String(flags.file)) : loadArtifactById(capabilityId);
  for (const param of artifact.inputs) {
    if (!(param.name in inputs)) continue;
    const raw = inputs[param.name];
    if (param.type === "number") inputs[param.name] = Number(raw);
    else if (param.type === "boolean") inputs[param.name] = String(raw) === "true";
    else inputs[param.name] = String(raw);
  }

  const browser = await chromium.launch({ headless: !flags.headed });
  const page = await browser.newPage();
  const runId = `replay-${capabilityId}-${Date.now()}`;
  const logger = new RunLogger(EVIDENCE_DIR, runId);

  const controlServer = flags["with-escalation"] ? new ControlServer() : undefined;
  if (controlServer) {
    await controlServer.start();
    logger.log("escalation.control_server_started", { url: controlServer.url });
    console.log(`Mock operator console: ${controlServer.url}`);
  }

  const autoResume = flags["auto-resume"]
    ? async (p: typeof page, intervention: InterventionRequest): Promise<ResumeSignal> => {
        logger.log("escalation.auto_resume_stand_in", { reason: intervention.reason });
        if (intervention.reason.includes("supervisor")) {
          await p.getByRole("button", { name: "Override (Supervisor)" }).click();
        } else if (intervention.reason.toLowerCase().includes("risky")) {
          // Stand-in for a human performing the irreversible action themselves, live.
          await p.getByRole("button", { name: "Confirm & Open Account" }).click().catch(() => {});
        }
        return { resumedBy: "scripted-operator-stand-in", note: "Automated stand-in for evidence reproducibility; see README." };
      }
    : undefined;

  try {
    logger.log("run.start", { capability: capabilityId, inputs, baseUrl: artifact.target.baseUrl });
    await login(page, BASE_URL);
    logger.log("auth.login_complete", {});

    const outcome = await replay({ artifact, inputs, page, logger, runId, controlServer, autoResume });
    logger.log("run.replay_outcome", outcome as unknown as Record<string, unknown>);
    logger.finalize({ status: outcome.status, outcome });

    console.log(`Replay outcome: ${outcome.status}`);
    console.log(JSON.stringify(outcome, null, 2));
    console.log(`Evidence written to ${logger.runDir}`);
  } finally {
    controlServer?.stop();
    await browser.close();
    stopMockApp();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, inputs } = parseArgs(rest);

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  if (cmd === "run") {
    await cmdRun(flags);
  } else if (cmd === "replay") {
    await cmdReplay(flags, inputs);
  } else {
    console.log(`Usage:
  tsx src/cli.ts run --memberId <id> [--headed]
  tsx src/cli.ts replay --capability <id> --input key=value [--input key2=value2] [--headed] [--with-escalation] [--auto-resume]`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
