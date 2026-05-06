export interface StageLogger {
  event(name: string, fields?: Record<string, unknown>): void;
}

export interface StageLoggerOptions {
  enabled?: boolean;
  write?: (message: string) => void;
}

const maxFieldLength = 180;

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
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxFieldLength) return compact;
  return `${compact.slice(0, maxFieldLength - 1)}...`;
}
