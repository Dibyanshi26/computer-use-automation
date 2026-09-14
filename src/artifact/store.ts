import fs from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

const DEFAULT_DIR = path.join(process.cwd(), "capabilities");

export function saveArtifact(artifact: CapabilityArtifact, dir: string = DEFAULT_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${artifact.id}.v${artifact.version}.json`);
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
  return file;
}

export function loadArtifact(file: string): CapabilityArtifact {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  return CapabilityArtifactSchema.parse(raw);
}

export function loadArtifactById(id: string, dir: string = DEFAULT_DIR): CapabilityArtifact {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${id}.v`) && f.endsWith(".json"));
  if (files.length === 0) throw new Error(`No artifact found for id "${id}" in ${dir}`);
  // Pick the highest version by simple string sort on the version segment.
  files.sort();
  return loadArtifact(path.join(dir, files[files.length - 1]));
}
