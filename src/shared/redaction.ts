const REDACTED = "[REDACTED]";
const sensitiveKey =
  /(?:token|authorization|password|passwd|secret|credential|api[-_]?key)/i;

export const redactSensitiveText = (value: string): string => {
  let redacted = value
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/g, REDACTED)
    .replace(/\b(Bearer\s+)\S+/gi, `$1${REDACTED}`)
    .replace(/([?&](?:token|access_token|api_key)=)[^&\s]+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s@]+@/gi, `$1${REDACTED}@`);
  for (const [key, environmentValue] of Object.entries(process.env)) {
    if (
      sensitiveKey.test(key) &&
      environmentValue !== undefined &&
      environmentValue.length >= 4
    ) {
      redacted = redacted.split(environmentValue).join(REDACTED);
    }
  }
  return redacted;
};

export const redactSensitiveValue = (value: unknown, key?: string): unknown => {
  if (key !== undefined && sensitiveKey.test(key)) return REDACTED;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitiveValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
};