import { stringField } from "./ai-tool-logging.js";
import type { StageLogger } from "./logging.js";
import { summarizeError } from "./logging.js";
import type { GitVibeConfig } from "../shared/types.js";

export function createRetryingFetch(options: {
  config: GitVibeConfig;
  logger?: StageLogger;
}): typeof fetch {
  const maxRetries = aiRequestRetryAttemptsFor(options.config);
  const baseDelayMs = aiRequestRetryDelayMsFor(options.config);
  return async (input, init) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(cloneFetchInput(input), init);
        if (!isRetryableHttpStatus(response.status) || attempt >= maxRetries) return response;

        const delayMs = retryDelayMsForHeaders(response.headers, baseDelayMs);
        options.logger?.event("ai.http.retry", {
          attempt: attempt + 1,
          delay_ms: delayMs,
          max_retries: maxRetries,
          status: response.status,
        });
        await discardResponse(response);
        await sleep(delayMs);
      } catch (error) {
        if (!isRetryableAiNetworkError(error) || attempt >= maxRetries) throw error;

        options.logger?.event("ai.http.retry", {
          attempt: attempt + 1,
          delay_ms: baseDelayMs,
          error: summarizeError(error),
          max_retries: maxRetries,
        });
        await sleep(baseDelayMs);
      }
    }
  };
}

export function retryDelayMsForHeaders(headers: Headers | undefined, fallbackMs: number): number {
  const retryAfterMs = numericHeader(headers, "retry-after-ms");
  if (retryAfterMs !== undefined) return retryAfterMs;

  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }

  const resetSeconds = numericHeader(headers, "x-ratelimit-reset");
  if (resetSeconds !== undefined) return Math.max(0, resetSeconds * 1000 - Date.now());

  return fallbackMs;
}

function aiRequestRetryAttemptsFor(config: GitVibeConfig): number {
  return nonNegativeInteger(configNumber(config.ai?.budgets, "request_retry_attempts"), 3);
}

function aiRequestRetryDelayMsFor(config: GitVibeConfig): number {
  return (
    nonNegativeInteger(configNumber(config.ai?.budgets, "request_retry_delay_seconds"), 60) * 1000
  );
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableAiNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  if (record.isRetryable === true) return true;
  if (record.isRetryable === false) return false;

  const text = `${stringField(error, "name") || ""} ${summarizeError(error)} ${summarizeError(record.cause)}`;
  return /Cannot connect to API|Headers Timeout|fetch failed|network|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_/i.test(
    text,
  );
}

function numericHeader(headers: Headers | undefined, name: string): number | undefined {
  const value = headerValue(headers, name);
  if (!value) return undefined;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.max(0, number) : undefined;
}

function headerValue(headers: Headers | undefined, name: string): string | undefined {
  return headers?.get(name) || undefined;
}

function cloneFetchInput(input: Parameters<typeof fetch>[0]): Parameters<typeof fetch>[0] {
  return input instanceof Request ? input.clone() : input;
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort body cleanup before retrying the same API request.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value as number));
}
