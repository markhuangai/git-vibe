import { stringField } from "./ai-tool-logging.js";
import type { StageLogger } from "./logging.js";
import { summarizeError } from "./logging.js";
import type { GitVibeConfig } from "../shared/types.js";

const DEFAULT_PROVIDER_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

export function createRetryingFetch(options: {
  config: GitVibeConfig;
  logger?: StageLogger;
}): typeof fetch {
  const maxRetries = aiRequestRetryAttemptsFor(options.config);
  const baseDelayMs = aiRequestRetryDelayMsFor(options.config);
  const maxResponseBytes = aiProviderResponseMaxBytesFor(options.config);
  return async (input, init) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = responseWithProviderResponseLimit(
          await fetch(cloneFetchInput(input), init),
          maxResponseBytes,
        );
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

function aiProviderResponseMaxBytesFor(config: GitVibeConfig): number {
  return positiveInteger(
    configNumber(config.ai?.budgets, "provider_response_max_bytes"),
    DEFAULT_PROVIDER_RESPONSE_MAX_BYTES,
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

function responseWithProviderResponseLimit(response: Response, maxBytes: number): Response {
  const contentLength = contentLengthBytes(response.headers);
  if (contentLength !== undefined && contentLength > maxBytes) {
    void discardResponse(response);
    throw providerResponseTooLargeError(maxBytes, contentLength);
  }
  if (!response.body) return response;

  // The AI SDK JSON handlers call response.text(); cap the stream before it can buffer without bound.
  return new Response(response.body.pipeThrough(providerResponseLimitStream(maxBytes)), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function providerResponseLimitStream(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let receivedBytes = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        controller.error(providerResponseTooLargeError(maxBytes, receivedBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

function contentLengthBytes(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (!value) return undefined;
  const bytes = Number.parseInt(value, 10);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

function providerResponseTooLargeError(
  maxBytes: number,
  receivedBytes: number,
): Error & { isRetryable: false } {
  return Object.assign(
    new Error(
      `AI provider response exceeded maximum size of ${maxBytes} bytes after ${receivedBytes} bytes.`,
    ),
    { isRetryable: false as const },
  );
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

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value as number));
}
