import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { redactObject } from "../safety/redact.js";

export interface LogEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

export class RunLogger {
  readonly runDir: string;
  readonly screenshotsDir: string;
  private events: LogEvent[] = [];

  constructor(baseDir: string, runId: string) {
    this.runDir = path.join(baseDir, runId);
    this.screenshotsDir = path.join(this.runDir, "screenshots");
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
  }

  log(type: string, data: Record<string, unknown> = {}): void {
    const event: LogEvent = { ts: new Date().toISOString(), type, ...redactObject(data) };
    this.events.push(event);
    // Print the already-redacted event, not the raw `data` -- otherwise a secret that never
    // reaches the persisted log.json would still leak to stdout (and anything that captures it).
    const { ts, type: _type, ...rest } = event;
    // eslint-disable-next-line no-console
    console.log(`[${ts}] ${type}`, JSON.stringify(rest).slice(0, 300));
  }

  async screenshot(page: Page, label: string): Promise<string> {
    const file = path.join(this.screenshotsDir, `${label}.png`);
    await page.screenshot({ path: file });
    return path.relative(this.runDir, file);
  }

  writeArtifactCopy(artifact: unknown): void {
    fs.writeFileSync(path.join(this.runDir, "artifact.json"), JSON.stringify(redactObject(artifact), null, 2));
  }

  finalize(summary: Record<string, unknown>): void {
    fs.writeFileSync(path.join(this.runDir, "log.json"), JSON.stringify(this.events, null, 2));
    fs.writeFileSync(path.join(this.runDir, "summary.json"), JSON.stringify(redactObject(summary), null, 2));
  }
}
