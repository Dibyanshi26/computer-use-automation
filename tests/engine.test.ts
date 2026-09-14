import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { app } from "../src/mock-app/app.js";
import { login } from "../src/agent/auth.js";
import { replay } from "../src/replay/engine.js";
import { RunLogger } from "../src/evidence/logger.js";
import { ControlServer, type InterventionRequest, type ResumeSignal } from "../src/escalation/controlServer.js";
import { loadArtifactById } from "../src/artifact/store.js";
import type { CapabilityArtifact } from "../src/artifact/schema.js";

// Matches the allowlist config and the absolute URLs baked into the checked-in capability
// artifacts, so these tests reuse them unmodified rather than rewriting URLs at test time.
// Requires port 4000 to be free (the manual `npm run mock-app` instance must not be running).
const PORT = 4000;
const BASE_URL = `http://localhost:${PORT}`;
let server: Server;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  process.env.MOCK_APP_PORT = String(PORT);
  server = app.listen(PORT);
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
  server.close();
});

function testLogger(name: string) {
  return new RunLogger("tests/.tmp-evidence", `${name}-${Date.now()}`);
}

describe("replay engine", () => {
  it("succeeds and extracts outputs for a member other than the one it was recorded on", async () => {
    const artifact = loadArtifactById("lookup-member-balance");
    artifact.target.baseUrl = BASE_URL;
    await login(page, BASE_URL);
    const outcome = await replay({ artifact, inputs: { memberId: "10002" }, page, logger: testLogger("success"), runId: "t1" });
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.outputs.checkingBalance).toBe("$500.00");
      expect(outcome.outputs.savingsBalance).toBe("$100.00");
    }
  });

  it("reports a business outcome (not a crash) for a member that does not exist", async () => {
    const artifact = loadArtifactById("lookup-member-balance");
    artifact.target.baseUrl = BASE_URL;
    await login(page, BASE_URL);
    const outcome = await replay({ artifact, inputs: { memberId: "99999" }, page, logger: testLogger("not-found"), runId: "t2" });
    expect(outcome.status).toBe("business_outcome");
    if (outcome.status === "business_outcome") expect(outcome.code).toBe("member_not_found");
  });

  it("reports a hard failure with debug detail when a step's locator can never resolve", async () => {
    const artifact = loadArtifactById("lookup-member-balance");
    artifact.target.baseUrl = BASE_URL;
    artifact.steps[2].locators = [{ strategy: "role", role: "button", name: "This Button Does Not Exist" }];
    await login(page, BASE_URL);
    const outcome = await replay({ artifact, inputs: { memberId: "10002" }, page, logger: testLogger("hard-failure"), runId: "t3" });
    expect(outcome.status).toBe("hard_failure");
    if (outcome.status === "hard_failure") {
      expect(outcome.debug.step).toBe("s3");
      expect(outcome.message).toContain("Could not resolve");
    }
  });

  it("escalates a risky/irreversible step to a human instead of executing it, then continues after resume", async () => {
    const base = loadArtifactById("open-subaccount-to-confirmation");
    const artifact: CapabilityArtifact = {
      ...base,
      steps: [
        ...base.steps,
        {
          id: "s10",
          action: "click",
          locators: [{ strategy: "role", role: "button", name: "Confirm & Open Account" }],
          riskLevel: "risky",
        },
      ],
      successCheckpoint: { type: "textPresent", text: "Sub-Account Opened" },
    };
    artifact.target.baseUrl = BASE_URL;

    const controlServer = new ControlServer(4502);
    await controlServer.start();
    let escalationSeen = false;
    const autoResume = async (p: Page, intervention: InterventionRequest): Promise<ResumeSignal> => {
      escalationSeen = true;
      expect(intervention.reason.toLowerCase()).toContain("risky");
      await p.getByRole("button", { name: "Confirm & Open Account" }).click();
      return { resumedBy: "test-operator" };
    };

    await login(page, BASE_URL);
    const outcome = await replay({
      artifact,
      inputs: { memberId: "10002", depositAmount: 100, nickname: "Test" },
      page,
      logger: testLogger("risky-escalation"),
      runId: "t4",
      controlServer,
      autoResume,
    });
    controlServer.stop();

    expect(escalationSeen).toBe(true);
    expect(outcome.status).toBe("success");
  });

  it("recovers from an unexpected interstitial by dismissing it, then continues (recovery: dismiss)", async () => {
    const artifact = loadArtifactById("open-subaccount-to-confirmation");
    artifact.target.baseUrl = BASE_URL;
    const navStep = artifact.steps.find((s) => s.action === "navigate");
    navStep!.value = `${navStep!.value}?inject=interstitial`;

    await login(page, BASE_URL);
    const logger = testLogger("recoverable-interstitial");
    const outcome = await replay({
      artifact,
      inputs: { memberId: "10002", depositAmount: 100, nickname: "Test" },
      page,
      logger,
      runId: "t5",
    });

    expect(outcome.status).toBe("success");
    logger.finalize({ status: outcome.status });
    const events = JSON.parse(fs.readFileSync(`${logger.runDir}/log.json`, "utf-8"));
    expect(events.some((e: any) => e.type === "replay.error_handler_matched" && e.code === "session_notice_interstitial")).toBe(true);
    expect(events.some((e: any) => e.type === "replay.recovery_dismiss")).toBe(true);
  });

  it("recovers from a transient slow load by waiting and retrying (recovery: retry)", async () => {
    const artifact = loadArtifactById("open-subaccount-to-confirmation");
    artifact.target.baseUrl = BASE_URL;
    const navStep = artifact.steps.find((s) => s.action === "navigate");
    navStep!.value = `${navStep!.value}?inject=slow`;

    await login(page, BASE_URL);
    const logger = testLogger("recoverable-slow-load");
    const outcome = await replay({
      artifact,
      inputs: { memberId: "10002", depositAmount: 100, nickname: "Test" },
      page,
      logger,
      runId: "t6",
    });

    expect(outcome.status).toBe("success");
    logger.finalize({ status: outcome.status });
    const events = JSON.parse(fs.readFileSync(`${logger.runDir}/log.json`, "utf-8"));
    expect(events.some((e: any) => e.type === "replay.error_handler_matched" && e.code === "slow_load")).toBe(true);
    expect(events.some((e: any) => e.type === "replay.recovery_wait_retry")).toBe(true);
  }, 15000);
});
