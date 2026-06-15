import { afterEach, describe, expect, it, vi } from "vitest";

import { createRetryingFetch } from "../src/runner/ai-retry.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AI provider response limits", () => {
  it("rejects provider responses whose declared size exceeds the configured limit", async () => {
    const logger = { event: vi.fn() };
    const retryingFetch = createRetryingFetch({
      config: config({ provider_response_max_bytes: 3, request_retry_delay_seconds: 0 }),
      logger,
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new globalThis.Response("large", {
        headers: { "content-length": "4" },
        status: 200,
      }),
    );

    await expect(retryingFetch("https://api.test/v1/chat/completions")).rejects.toThrow(
      "AI provider response exceeded maximum size of 3 bytes after 4 bytes.",
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(logger.event).not.toHaveBeenCalledWith("ai.http.retry", expect.any(Object));
  });

  it("rejects chunked provider responses that cross the configured limit", async () => {
    const retryingFetch = createRetryingFetch({
      config: config({ provider_response_max_bytes: 3 }),
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new globalThis.Response("large", { status: 200 }));

    const response = await retryingFetch("https://api.test/v1/chat/completions");

    await expect(response.text()).rejects.toThrow(
      "AI provider response exceeded maximum size of 3 bytes after 5 bytes.",
    );
  });

  it("retries declared oversized retryable responses before applying the limit", async () => {
    const logger = { event: vi.fn() };
    const retryingFetch = createRetryingFetch({
      config: config({
        provider_response_max_bytes: 3,
        request_retry_attempts: 1,
        request_retry_delay_seconds: 0,
      }),
      logger,
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new globalThis.Response("large", {
          headers: { "content-length": "4" },
          status: 500,
        }),
      )
      .mockResolvedValueOnce(
        new globalThis.Response("ok", {
          headers: { "content-length": "2" },
          status: 200,
        }),
      );

    const response = await retryingFetch("https://api.test/v1/chat/completions");

    await expect(response.text()).resolves.toBe("ok");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(logger.event).toHaveBeenCalledWith(
      "ai.http.retry",
      expect.objectContaining({ attempt: 1, status: 500 }),
    );
  });

  it("rejects invalid explicit provider response limits", () => {
    expect(() =>
      createRetryingFetch({
        config: config({ provider_response_max_bytes: "3" }),
      }),
    ).toThrow("ai.budgets.provider_response_max_bytes must be a positive integer.");

    expect(() =>
      createRetryingFetch({
        config: config({ provider_response_max_bytes: 0 }),
      }),
    ).toThrow("ai.budgets.provider_response_max_bytes must be a positive integer.");
  });
});

/** @param {Record<string, unknown>} budgets */
function config(budgets) {
  return { ai: { budgets } };
}
