import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema } from "../src/artifact/schema.js";

const capabilitiesDir = path.join(process.cwd(), "capabilities");

describe("CapabilityArtifactSchema", () => {
  it("validates every saved capability artifact", () => {
    const files = fs.readdirSync(capabilitiesDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(capabilitiesDir, file), "utf-8"));
      const result = CapabilityArtifactSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(`${file} failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`);
      }
    }
  });

  it("rejects an artifact missing a required field", () => {
    const bad = { schemaVersion: "1.0", id: "x" };
    const result = CapabilityArtifactSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
