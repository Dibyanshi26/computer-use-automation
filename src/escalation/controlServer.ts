import express from "express";
import type { Server } from "node:http";
import fs from "node:fs";

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

/**
 * Minimal, real handoff mechanism: automation pauses, this server exposes
 * the intervention context (goal/step/reason/screenshot) and a mock
 * operator page with a single Resume action. The browser itself stays the
 * SAME live, visible (headed) Playwright session the whole time -- nothing
 * about the underlying page is torn down or recreated across the handoff.
 * The operator console UI is intentionally a bare mock (see REPORT.md,
 * Escalation & handoff); the pause/resume/control-transfer mechanism is
 * real.
 */
export class ControlServer {
  private app = express();
  private server: Server | null = null;
  private current: InterventionRequest | null = null;
  private resolveResume: ((s: ResumeSignal) => void) | null = null;
  private port: number;

  constructor(port = Number(process.env.CONTROL_SERVER_PORT ?? 4100)) {
    this.port = port;
    this.app.use(express.json());

    this.app.get("/intervention", (_req, res) => {
      res.json(this.current);
    });

    this.app.get("/screenshot", (_req, res) => {
      if (!this.current) {
        res.status(404).end();
        return;
      }
      res.sendFile(this.current.screenshotFile);
    });

    this.app.post("/resume", (req, res) => {
      const { resumedBy, note } = req.body as ResumeSignal;
      if (!this.resolveResume) {
        res.status(409).json({ error: "No pending intervention." });
        return;
      }
      const resolve = this.resolveResume;
      this.resolveResume = null;
      this.current = null;
      resolve({ resumedBy: resumedBy || "operator", note });
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
    this.server?.close();
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  /** Raises an intervention and blocks until an operator (or scripted stand-in) calls /resume. */
  async requestIntervention(details: Omit<InterventionRequest, "createdAt">): Promise<ResumeSignal> {
    this.current = { ...details, createdAt: new Date().toISOString() };
    return new Promise((resolve) => {
      this.resolveResume = resolve;
    });
  }
}

function operatorConsoleHtml(): string {
  return `<!DOCTYPE html>
<html><head><title>Operator Console (mock)</title></head>
<body>
<h1>Intervention Queue</h1>
<div id="content">Loading...</div>
<script>
async function load() {
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
