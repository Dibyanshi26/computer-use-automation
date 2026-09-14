import { describe, it, expect } from "vitest";
import { assertUrlAllowed, assertOriginAllowed, isBlockedByName, GuardrailViolation, loadAllowlist } from "../src/safety/allowlist.js";
import { classifyActionRisk } from "../src/safety/riskClassifier.js";
import { redactObject, isSensitiveFieldName } from "../src/safety/redact.js";

describe("allowlist", () => {
  const config = loadAllowlist();

  it("allows an in-allowlist route", () => {
    expect(() => assertUrlAllowed("http://localhost:4000/search")).not.toThrow();
  });

  it("blocks a disallowed origin", () => {
    expect(() => assertOriginAllowed("https://evil.example.com/search")).toThrow(GuardrailViolation);
  });

  it("blocks a route not matching any allowed pattern", () => {
    expect(() => assertUrlAllowed("http://localhost:4000/admin/wipe-database")).toThrow(GuardrailViolation);
  });

  it("flags blocked action names like delete/wire transfer", () => {
    expect(isBlockedByName("Delete Member", config)).toBe(true);
    expect(isBlockedByName("Wire Transfer Funds", config)).toBe(true);
    expect(isBlockedByName("Search", config)).toBe(false);
  });
});

describe("riskClassifier", () => {
  it("classifies navigation/extract/wait as always safe", () => {
    expect(classifyActionRisk("navigate", "Confirm & Submit")).toBe("safe");
    expect(classifyActionRisk("extract", "Confirm & Submit")).toBe("safe");
  });

  it("classifies a click on a confirm/submit/override control as risky", () => {
    expect(classifyActionRisk("click", "Confirm & Open Account")).toBe("risky");
    expect(classifyActionRisk("click", "Override (Supervisor)")).toBe("risky");
  });

  it("classifies a click on a read-only navigation control as safe", () => {
    expect(classifyActionRisk("click", "View")).toBe("safe");
    expect(classifyActionRisk("click", "Search")).toBe("safe");
  });
});

describe("redact", () => {
  it("redacts sensitive field names by key, recursively", () => {
    const redacted = redactObject({ username: "teller1", password: "hunter2", nested: { token: "abc", ok: "fine" } });
    expect(redacted).toEqual({ username: "teller1", password: "[REDACTED]", nested: { token: "[REDACTED]", ok: "fine" } });
  });

  it("recognizes common secret field name patterns", () => {
    expect(isSensitiveFieldName("password")).toBe(true);
    expect(isSensitiveFieldName("apiToken")).toBe(true);
    expect(isSensitiveFieldName("memberId")).toBe(false);
  });
});
