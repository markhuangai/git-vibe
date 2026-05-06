export interface StageLogger {
  event(name: string, fields?: Record<string, unknown>): void;
}

export interface StageLoggerOptions {
  enabled?: boolean;
  write?: (message: string) => void;
}

const maxFieldLength = 180;
const tokenPatterns = [
  /\bgithub_pat_[A-Za-z0-9_]+\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]+\b/g,
  /\bsk-[A-Za-z0-9_-]+\b/g,
];

export function createStageLogger(stage: string, options: StageLoggerOptions = {}): StageLogger {
  const enabled = options.enabled ?? process.env.GITVIBE_LOG_PROGRESS !== "false";
  const write = options.write || console.log;

  return {
    event(name, fields = {}) {
      if (!enabled) return;
      write(`[git-vibe] ${stage} ${name}${formatFields(fields)}`);
    },
  };
}

export function summarizeError(error: unknown): string {
  if (error instanceof Error) return sanitizeValue(error.message);
  return sanitizeValue(String(error));
}

function formatFields(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${formatValue(value)}`);

  return parts.length ? ` ${parts.join(" ")}` : "";
}

function formatValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(sanitizeValue(String(value)));
}

function sanitizeValue(value: string): string {
  const compact = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxFieldLength) return compact;
  return `${compact.slice(0, maxFieldLength - 1)}...`;
}

function redactSecrets(value: string): string {
  let redacted = value;
  for (const pattern of tokenPatterns) {
    redacted = redacted.replace(pattern, "<redacted>");
  }

  for (const [name, secret] of Object.entries(process.env)) {
    if (!sensitiveName(name) || !secret || secret.length < 6) continue;
    redacted = redacted.split(secret).join(`<redacted:${name}>`);
  }

  return redacted;
}

function sensitiveName(name: string): boolean {
  return /(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i.test(name);
}
