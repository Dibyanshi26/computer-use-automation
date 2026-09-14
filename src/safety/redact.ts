/**
 * Redaction for anything written to logs, evidence, or artifacts. This is
 * regulated financial data: we never persist credentials, and we mask
 * free-text values typed into password-like fields. Field values that are
 * legitimately part of a capability's declared inputs/outputs (e.g. a
 * member id used as a lookup key) are NOT redacted here — only secrets.
 */
const SENSITIVE_FIELD_NAME_PATTERN = /(password|passwd|secret|token|ssn|ccnum|card.?number)/i;

export function isSensitiveFieldName(fieldName: string): boolean {
  return SENSITIVE_FIELD_NAME_PATTERN.test(fieldName);
}

export function redactValueForField(fieldName: string, value: string): string {
  return isSensitiveFieldName(fieldName) ? "[REDACTED]" : value;
}

/** Deep-redacts any object key matching the sensitive pattern before it is logged or persisted. */
export function redactObject<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactObject(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveFieldName(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = redactObject(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
