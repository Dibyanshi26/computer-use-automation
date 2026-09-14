import "dotenv/config";
import { chromium } from "playwright";
import { runDiscovery } from "./agent/discoveryLoop.js";
import { login } from "./agent/auth.js";
import { DISCOVERY_SPECS } from "./agent/discoverySpecs.js";
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

async function cmdRun(flags: Record<string, string | boolean>, inputs: Record<string, unknown>) {
  const capabilityId = String(flags.capability ?? "lookup-member-balance");
  const spec = DISCOVERY_SPECS[capabilityId];
  if (!spec) {
    throw new Error(`Unknown discovery capability "${capabilityId}". Known: ${Object.keys(DISCOVERY_SPECS).join(", ")}`);
  }

  const params: Record<string, string> = {};
  for (const param of spec.inputs) {
    if (!(param.name in inputs)) {
      throw new Error(`Missing --input ${param.name}=... for capability "${capabilityId}".`);
    }
    params[param.name] = String(inputs[param.name]);
  }

  await ensureMockAppRunning(BASE_URL);

  const browser = await chromium.launch({ headless: !flags.headed });
  const page = await browser.newPage();
  const runId = `discovery-${Date.now()}`;
  const logger = new RunLogger(EVIDENCE_DIR, runId);

  try {
    logger.log("run.start", { capability: spec.id, params, baseUrl: BASE_URL });
    await login(page, BASE_URL);
    logger.log("auth.login_complete", {});

    const goal = spec.buildGoal(params);
    const maxSteps = flags.maxSteps ? Number(flags.maxSteps) : 20;
    const result = await runDiscovery(page, { goal, startUrl: `${BASE_URL}${spec.startPath}`, maxSteps }, logger);
    logger.log("run.discovery_result", result as unknown as Record<string, unknown>);

    if (!result.success) {
      logger.finalize({ status: "failed", stopReason: result.stopReason, escalated: result.escalated });
      console.error(`Discovery did not complete successfully: ${result.stopReason}`);
      process.exitCode = 1;
      return;
    }

    const outputs = typeof spec.outputs === "function" ? spec.outputs(result.outputs) : spec.outputs;
    const artifact = recordArtifact(result, {
      id: spec.id,
      name: spec.name,
      version: "1.0",
      description: spec.description,
      app: spec.app,
      baseUrl: BASE_URL,
      runId,
      discoveredBy: process.env.OPENAI_MODEL ?? "gpt-4o",
      parameterize: spec.parameterize(params),
      inputs: spec.inputs,
      outputs,
      successCheckpoint: spec.successCheckpoint,
      errorHandlers: spec.errorHandlers,
      maxRiskLevel: spec.maxRiskLevel,
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

  // Demo/test hook: attach ?inject=<mode> to the artifact's first navigate step so the mock
  // app renders a controlled fault (slow/interstitial/timeout) instead of its normal response,
  // exercising replay's recoverable-error handling deterministically. See src/mock-app/app.ts.
  if (flags.inject) {
    const navStep = artifact.steps.find((s) => s.action === "navigate" && s.value);
    if (!navStep || !navStep.value) {
      throw new Error("--inject requires the artifact to have a navigate step with a literal URL.");
    }
    const sep = navStep.value.includes("?") ? "&" : "?";
    navStep.value = `${navStep.value}${sep}inject=${flags.inject}`;
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
    await cmdRun(flags, inputs);
  } else if (cmd === "replay") {
    await cmdReplay(flags, inputs);
  } else {
    console.log(`Usage:
  tsx src/cli.ts run --capability <id> --input key=value [--input key2=value2] [--headed]
    known capabilities: ${Object.keys(DISCOVERY_SPECS).join(", ")}
  tsx src/cli.ts replay --capability <id> --input key=value [--input key2=value2] [--headed] [--with-escalation] [--auto-resume]`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
