export interface StageLogger {
  event(name: string, fields?: Record<string, unknown>): void;
  raw?(message: string): void;
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
    raw(message) {
      if (!enabled) return;
      write(redactLogText(message));
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
    .map(([key, value]) => `${key}=${formatValue(key, value)}`);

  return parts.length ? ` ${parts.join(" ")}` : "";
}

function formatValue(key: string, value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && isDurationField(key) && Number.isFinite(value)) {
      return value.toFixed(2);
    }
    return String(value);
  }

  return JSON.stringify(sanitizeValue(String(value)));
}

function isDurationField(key: string): boolean {
  return key.toLowerCase().includes("duration");
}

function sanitizeValue(value: string): string {
  const compact = redactLogText(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxFieldLength) return compact;
  return `${compact.slice(0, maxFieldLength - 1)}...`;
}

export function redactLogText(value: string): string {
  let redacted = value;
  for (const pattern of tokenPatterns) {
    redacted = redacted.replace(pattern, "<redacted>");
  }

  for (const [name, secret] of Object.entries(process.env)) {
    if (!sensitiveName(name) || !secret || secret.length < 6) continue;
    redacted = redacted.split(secret).join(`<redacted:${name}>`);
  }

  for (const [bundle, name, secret] of envBundleSecrets()) {
    redacted = redacted.split(secret).join(`<redacted:${bundle}.${name}>`);
  }

  return redacted;
}

function sensitiveName(name: string): boolean {
  return /(^|_)(AUTH|AUTHORIZATION|CREDENTIALS?|KEY|PASSWORD|SECRET|TOKEN)(_|$)/i.test(name);
}

function envBundleSecrets(): Array<[string, string, string]> {
  return ["GITVIBE_AI_ENV_JSON", "GITVIBE_MCP_ENV_JSON"].flatMap((bundle) => bundleSecrets(bundle));
}

function bundleSecrets(bundle: string): Array<[string, string, string]> {
  const raw = process.env[bundle];
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .filter(([, value]) => value.length >= 6)
      .map(([name, value]): [string, string, string] => [bundle, name, value]);
  } catch {
    return [];
  }
}
