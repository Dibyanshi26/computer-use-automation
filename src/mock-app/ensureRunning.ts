import { spawn, type ChildProcess } from "node:child_process";

let child: ChildProcess | null = null;

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Starts the mock app as a child process if it isn't already listening. Idempotent. */
export async function ensureMockAppRunning(baseUrl: string): Promise<void> {
  if (await isUp(`${baseUrl}/login`)) return;
  child = spawn("npx", ["tsx", "src/mock-app/server.ts"], {
    stdio: "inherit",
    env: process.env,
  });
  for (let i = 0; i < 40; i++) {
    if (await isUp(`${baseUrl}/login`)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Mock app did not become ready at ${baseUrl}`);
}

export function stopMockApp(): void {
  child?.kill();
  child = null;
}
