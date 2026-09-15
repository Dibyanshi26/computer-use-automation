import express from "express";
import type { Server } from "node:http";
import type { Page, Frame, Request } from "playwright";
import type { RunLogger } from "../evidence/logger.js";

export interface InterventionRequest {
  runId: string;
  capability: string;
  goal: string;
  stepId: string;
  reason: string;
  screenshotFile: string; // absolute path
  createdAt: string;
}

export interface ResumeSignal {
  resumedBy: string;
  note?: string;
}

export type ControlHolder = "automation" | "human";

export interface ControlState {
  holder: ControlHolder;
  who: string;
  since: string; // ISO timestamp
}

/**
 * Minimal, real handoff mechanism: automation pauses, this server exposes
 * the intervention context (goal/step/reason/screenshot) and a mock
 * operator page with a single Resume action. The browser itself stays the
 * SAME live, visible (headed) Playwright session the whole time -- nothing
 * about the underlying page is torn down or recreated across the handoff.
 * The operator console UI is intentionally a bare mock (see REPORT.md,
 * Escalation & handoff); the pause/resume/control-transfer mechanism is
 * real.
 *
 * Control-transfer state machine: exactly two states, "automation" and
 * "human". requestIntervention() flips automation -> human; resume() flips
 * human -> automation. Both flips log a `control.transferred` event to the
 * run's own log (not a side channel), and the current state is exposed at
 * GET /control for the operator console to render. Whichever path calls
 * resume() -- the real POST /resume handler, or the --auto-resume scripted
 * stand-in -- goes through this exact same method, so there is no separate,
 * unlogged way for control to return to automation.
 */
export class ControlServer {
  private app = express();
  private server: Server | null = null;
  private current: InterventionRequest | null = null;
  private resolveResume: ((s: ResumeSignal) => void) | null = null;
  private port: number;
  private logger: RunLogger;

  private controlState: ControlState;

  // The live page control is currently transferred over, and the listeners recording what the
  // human does with it -- attached in requestIntervention(), detached in resume(). If they were
  // left attached, automation's own post-resume actions would keep being logged as human.action.
  private currentPage: Page | null = null;
  private onFrameNavigated: ((frame: Frame) => void) | null = null;
  private onRequest: ((request: Request) => void) | null = null;

  constructor(logger: RunLogger, port = Number(process.env.CONTROL_SERVER_PORT ?? 4100)) {
    this.logger = logger;
    this.port = port;
    this.controlState = { holder: "automation", who: "automation", since: new Date().toISOString() };
    this.app.use(express.json());

    this.app.get("/intervention", (_req, res) => {
      res.json(this.current);
    });

    this.app.get("/control", (_req, res) => {
      res.json(this.controlState);
    });

    this.app.get("/screenshot", (_req, res) => {
      if (!this.current) {
        res.status(404).end();
        return;
      }
      res.sendFile(this.current.screenshotFile);
    });

    this.app.post("/resume", async (req, res) => {
      const { resumedBy, note } = (req.body ?? {}) as Partial<ResumeSignal>;
      const result = await this.resume(resumedBy || "operator", note);
      if (!result.ok) {
        res.status(409).json({ error: "No pending intervention." });
        return;
      }
      res.json({ ok: true });
    });

    this.app.get("/", (_req, res) => {
      res.send(operatorConsoleHtml());
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => resolve());
    });
  }

  stop(): void {
    this.detachListeners();
    this.server?.close();
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  private detachListeners(): void {
    if (this.currentPage && this.onFrameNavigated) {
      this.currentPage.off("framenavigated", this.onFrameNavigated);
    }
    if (this.currentPage && this.onRequest) {
      this.currentPage.off("request", this.onRequest);
    }
    this.onFrameNavigated = null;
    this.onRequest = null;
  }

  /**
   * Raises an intervention, transfers control to "human", and blocks until resume() is called
   * (by the real /resume endpoint or the autoResume stand-in -- both go through resume()).
   * While control is held, every navigation and every navigation/form-post request on the live
   * page is recorded as a human.action event, so the run log states what the human actually did,
   * not just that a handoff happened.
   */
  requestIntervention(page: Page, details: Omit<InterventionRequest, "createdAt">): Promise<ResumeSignal> {
    this.current = { ...details, createdAt: new Date().toISOString() };
    this.currentPage = page;
    const stepId = details.stepId;

    this.onFrameNavigated = (frame) => {
      if (frame !== page.mainFrame()) return;
      this.logger.log("human.action", { source: "framenavigated", stepId, url: frame.url() });
    };
    this.onRequest = (request) => {
      if (!request.isNavigationRequest() && request.method() !== "POST") return;
      this.logger.log("human.action", { source: "request", stepId, url: request.url(), method: request.method() });
    };
    page.on("framenavigated", this.onFrameNavigated);
    page.on("request", this.onRequest);

    this.controlState = { holder: "human", who: "pending", since: new Date().toISOString() };
    this.logger.log("control.transferred", {
      holder: this.controlState.holder,
      who: this.controlState.who,
      since: this.controlState.since,
      previousHolder: "automation",
      stepId,
      reason: details.reason,
    });

    return new Promise((resolve) => {
      this.resolveResume = resolve;
    });
  }

  /**
   * Hands control back to automation: detaches the human-action listeners (before anything else,
   * so nothing automation does next is misattributed), captures a post-handoff screenshot and the
   * URL the human left the session on, transfers control back to "automation", and logs both. Used
   * identically by the real POST /resume handler and by the --auto-resume stand-in -- there is no
   * second, shorter path back to automation.
   */
  async resume(resumedBy: string, note?: string): Promise<{ ok: boolean }> {
    if (!this.resolveResume) {
      return { ok: false };
    }
    const resolve = this.resolveResume;
    this.resolveResume = null;

    const page = this.currentPage;
    const stepId = this.current?.stepId ?? "unknown";
    this.detachListeners();

    let screenshotPath: string | undefined;
    let leftOnUrl: string | undefined;
    if (page) {
      // The human's last action (a click, a form submit) may still have a navigation in flight
      // when resume() is called; screenshotting mid-navigation throws ("execution context
      // destroyed"). Let it settle first so the screenshot -- and the URL we log -- reflect
      // where the human actually left the page, not a transient state.
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      leftOnUrl = page.url();
      screenshotPath = await this.logger.screenshot(page, `post-handoff-${stepId}`).catch((err) => {
        this.logger.log("control.post_handoff_screenshot_failed", { stepId, error: (err as Error).message });
        return undefined;
      });
    }

    this.controlState = { holder: "automation", who: "automation", since: new Date().toISOString() };
    this.logger.log("control.transferred", {
      holder: this.controlState.holder,
      who: this.controlState.who,
      since: this.controlState.since,
      previousHolder: "human",
      resumedBy,
      note,
      leftOnUrl,
      screenshotPath,
    });

    this.current = null;
    this.currentPage = null;
    resolve({ resumedBy, note });
    return { ok: true };
  }
}

function operatorConsoleHtml(): string {
  return `<!DOCTYPE html>
<html><head><title>Operator Console (mock)</title></head>
<body>
<h1>Intervention Queue</h1>
<div id="control-state">Loading control state...</div>
<hr>
<div id="content">Loading...</div>
<script>
async function loadControl() {
  const res = await fetch('/control');
  const data = await res.json();
  const el = document.getElementById('control-state');
  el.innerHTML = \`Control held by: <b>\${data.holder.toUpperCase()}</b> (who: \${data.who}, since \${data.since})\`;
}
async function load() {
  await loadControl();
  const res = await fetch('/intervention');
  const data = await res.json();
  const el = document.getElementById('content');
  if (!data) { el.innerHTML = '<p>No pending intervention.</p>'; return; }
  el.innerHTML = \`
    <table border="1" cellpadding="6">
      <tr><td>Run ID</td><td>\${data.runId}</td></tr>
      <tr><td>Capability</td><td>\${data.capability}</td></tr>
      <tr><td>Goal</td><td>\${data.goal}</td></tr>
      <tr><td>Stuck at step</td><td>\${data.stepId}</td></tr>
      <tr><td>Reason</td><td>\${data.reason}</td></tr>
    </table>
    <p><img src="/screenshot" width="480" alt="live session screenshot"></p>
    <p><i>The live browser window is visible on the automation host; an operator can act in it directly.</i></p>
    <button id="resumeBtn">Resume Automation</button>
  \`;
  document.getElementById('resumeBtn').onclick = async () => {
    await fetch('/resume', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ resumedBy: 'mock-operator' }) });
    load();
  };
}
load();
</script>
</body></html>`;
}
