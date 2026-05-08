// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));

vi.mock("ai", () => ({
  generateText,
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));

const { retryDelayMsForHeaders, runAiStage } = await import("../src/runner/ai.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  generateText.mockReset();
  createOpenAI.mockClear();
  createAnthropic.mockClear();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_API_KEY: "test-key",
    GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    GITVIBE_AI_MODEL: "test-model",
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

describe("AI stage runner OpenAI-compatible profiles", () => {
  it("calls AI SDK with provider config, tools, and tool telemetry", async () => {
    process.env.OPENAI_KEY = "openai-key";
    process.env.OPENAI_MODEL = "gpt-test";
    process.env.OPENAI_BASE_URL = "https://proxy.test/v1";
    const logger = { event: vi.fn() };
    mockTelemetryGenerateText();

    await expect(
      runAiStage({
        config: openAiCompatibleConfig(),
        cwd: process.cwd(),
        logger,
        maxTurns: 3,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stage: "investigate",
        stageDefinition: stageDefinitions.investigate,
        system: "System",
      }),
    ).resolves.toBe('{"stage":"investigate","status":"completed"}');

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "openai-key", baseURL: "https://proxy.test/v1" }),
    );
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
        prompt: "Prompt",
        providerOptions: { custom: true },
        stopWhen: { count: 3 },
        system: "System",
        temperature: 0.5,
      }),
    );
    expect(logger.event).toHaveBeenCalledWith("ai.request.start", expect.any(Object));
    expect(logger.event).toHaveBeenCalledWith("ai.tool.start", {
      call_id: "call-read",
      file: "src/index.ts",
      limit: 20,
      offset: 10,
      step: 1,
      tool: "read",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.tool.done", {
      call_id: "call-read",
      duration_ms: 12,
      error: undefined,
      result_chars: 21,
      result_lines: 2,
      step: undefined,
      tool: "read",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.tool.start", {
      call_id: undefined,
      content_chars: 67,
      content_keys: "comment_body,stage,status",
      stage: "investigate",
      step: undefined,
      status: "completed",
      tool: "output_validator",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.tool.failed", {
      call_id: "call-bash",
      duration_ms: undefined,
      error: "denied",
      step: undefined,
      tool: "bash",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.step.done", {
      finish_reason: "stop",
      step: 1,
      tool_calls: 2,
      tools: "read,output_validator",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.request.done", {
      steps: 1,
      tool_calls: 2,
      tools_used: "read,output_validator",
    });
  });
});

describe("AI stage runner tool telemetry", () => {
  it("logs compact summaries for supported tool inputs", async () => {
    const logger = { event: vi.fn() };
    mockToolSummaryGenerateText();

    await expect(
      runAiStage({
        config: localProxyConfig({ stage: "implement" }),
        cwd: process.cwd(),
        logger,
        maxTurns: 2,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stage: "implement",
        stageDefinition: stageDefinitions.implement,
        system: "System",
      }),
    ).resolves.toBe('{"stage":"validate","status":"completed"}');

    expect(logger.event).toHaveBeenCalledWith(
      "ai.tool.start",
      expect.objectContaining({ path: "src", pattern: "**/*.ts", tool: "glob" }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.tool.start",
      expect.objectContaining({ glob: "*.ts", output_mode: "content", tool: "grep" }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.tool.start",
      expect.objectContaining({ command: "rg TODO src", tool: "bash" }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.tool.start",
      expect.objectContaining({ file: "src/index.ts", new_chars: 3, tool: "edit" }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.tool.start",
      expect.objectContaining({
        allowed_domains: "github.com,docs.github.com",
        tool: "web_search",
      }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.tool.done",
      expect.objectContaining({ result_keys: "valid", tool: "glob" }),
    );
  });
});

function mockTelemetryGenerateText() {
  generateText.mockImplementationOnce(async (request) => {
    emitReadToolTelemetry(request);
    emitOutputValidatorTelemetry(request);
    emitFailedBashTelemetry(request);
    request.onStepFinish({
      finishReason: "stop",
      toolCalls: [{ toolName: "read" }, { toolName: "output_validator" }],
    });
    return {
      steps: [{ toolCalls: [{ toolName: "read" }, { toolName: "output_validator" }] }],
      text: '{"stage":"investigate","status":"completed"}',
    };
  });
}

function emitReadToolTelemetry(request) {
  request.experimental_onToolCallStart({
    stepNumber: 0,
    toolCall: {
      input: { file_path: "src/index.ts", limit: 20, offset: 10 },
      toolCallId: "call-read",
      toolName: "read",
    },
  });
  request.experimental_onToolCallFinish({
    durationMs: 12,
    output: "1\tline one\n2\tline two",
    success: true,
    toolCall: {
      input: { file_path: "src/index.ts" },
      toolCallId: "call-read",
      toolName: "read",
    },
  });
}

function emitOutputValidatorTelemetry(request) {
  request.experimental_onToolCallStart({
    toolCall: {
      input: {
        content: JSON.stringify({
          comment_body: "Done.",
          stage: "investigate",
          status: "completed",
        }),
      },
      toolName: "output_validator",
    },
  });
}

function emitFailedBashTelemetry(request) {
  request.experimental_onToolCallFinish({
    error: new Error("denied"),
    success: false,
    toolCall: {
      input: { command: "rg TODO src" },
      toolCallId: "call-bash",
      toolName: "bash",
    },
  });
}

function mockToolSummaryGenerateText() {
  generateText.mockImplementationOnce(async (request) => {
    for (const toolCall of toolSummaryCalls()) {
      request.experimental_onToolCallStart({ toolCall });
    }
    request.experimental_onToolCallStart({
      input: { count: 2, flag: true, items: ["a", "b"], nested: { value: true } },
      toolName: "custom_tool",
    });
    request.experimental_onToolCallStart({
      toolCall: { input: { content: "not json" }, toolName: "output_validator" },
    });
    request.experimental_onToolCallFinish({
      durationMs: 4,
      output: { valid: true },
      success: true,
      toolCall: { toolName: "glob" },
    });
    return {
      steps: [{ toolCalls: [] }],
      text: '{"stage":"validate","status":"completed"}',
    };
  });
}

async function createRetryingProviderFetch({ config = localProxyConfig(), logger }) {
  generateText.mockResolvedValueOnce({
    steps: [],
    text: '{"stage":"investigate","status":"completed"}',
  });

  await runAiStage({
    config,
    cwd: process.cwd(),
    logger,
    maxTurns: 1,
    prompt: "Prompt",
    schema: {},
    schemaId: "schema",
    stage: "investigate",
    stageDefinition: stageDefinitions.investigate,
    system: "System",
  });

  return createOpenAI.mock.calls.at(-1)[0].fetch;
}

function toolSummaryCalls() {
  return [
    { input: { path: "src", pattern: "**/*.ts" }, toolName: "glob" },
    {
      input: { glob: "*.ts", output_mode: "content", pattern: "TODO", path: "src", "-n": true },
      toolName: "grep",
    },
    {
      input: { command: "rg TODO src", description: "Find todos", timeout: 1000 },
      toolName: "bash",
    },
    {
      input: {
        file_path: "src/index.ts",
        new_content: "new",
        old_content: "old text",
        other_file_path: "src/other.ts",
      },
      toolName: "diff",
    },
    {
      input: { file_path: "src/index.ts", new_string: "new", old_string: "old", replace_all: true },
      toolName: "edit",
    },
    { input: { content: "hello", file_path: "README.md" }, toolName: "write" },
    {
      input: { edits: [{ new_string: "b", old_string: "a" }], file_path: "src/a.ts" },
      toolName: "multi_edit",
    },
    { input: { url: "https://example.com" }, toolName: "web_fetch" },
    {
      input: { allowed_domains: ["github.com", "docs.github.com"], query: "GitHub API" },
      toolName: "web_search",
    },
  ];
}

describe("AI stage runner provider failures", () => {
  it("uses direct AI SDK profile model names without a model variable", async () => {
    delete process.env.GITVIBE_AI_MODEL;
    const logger = { event: vi.fn() };
    generateText.mockResolvedValueOnce({
      steps: [],
      text: '{"stage":"investigate","status":"completed"}',
    });

    await expect(
      runAiStage({
        config: localProxyConfig(),
        cwd: process.cwd(),
        logger,
        maxTurns: 1,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stage: "investigate",
        stageDefinition: stageDefinitions.investigate,
        system: "System",
      }),
    ).resolves.toBe('{"stage":"investigate","status":"completed"}');

    expect(createOpenAI.mock.results.at(-1).value.chat).toHaveBeenCalledWith("glm-5");
    expect(logger.event).toHaveBeenCalledWith(
      "ai.request.start",
      expect.objectContaining({ model: "glm-5" }),
    );
  });

  it("requires direct AI SDK profile model names", async () => {
    await expect(
      runAiStage({
        config: localProxyConfig({ model: "" }),
        cwd: process.cwd(),
        maxTurns: 1,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stage: "investigate",
        stageDefinition: stageDefinitions.investigate,
        system: "System",
      }),
    ).rejects.toThrow("AI SDK profile provider.model must be configured.");
  });

  it("supports anthropic profiles and reports malformed AI responses", async () => {
    process.env.ANTHROPIC_KEY = "anthropic-key";
    generateText.mockResolvedValueOnce({ steps: [], text: "not json" });

    await expect(
      runAiStage({
        config: anthropicConfig(),
        cwd: process.cwd(),
        maxTurns: 1,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stage: "summarize",
        stageDefinition: stageDefinitions.summarize,
        system: "System",
      }),
    ).rejects.toThrow("AI response did not contain a JSON object");

    expect(createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "anthropic-key", fetch: expect.any(Function) }),
    );
  });

  it("requires configured AI environment variables", async () => {
    delete process.env.GITVIBE_AI_BASE_URL;

    await expect(
      runAiStage({
        config: localProxyConfig(),
        cwd: process.cwd(),
        maxTurns: 1,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stage: "investigate",
        stageDefinition: stageDefinitions.investigate,
        system: "System",
      }),
    ).rejects.toThrow("GITVIBE_AI_BASE_URL is required");
  });
});

describe("AI stage runner provider HTTP retries", () => {
  it("retries transient provider fetch failures with the configured delay", async () => {
    const logger = { event: vi.fn() };
    const retryingFetch = await createRetryingProviderFetch({
      config: localProxyConfig({ budgets: { request_retry_delay_seconds: 0 } }),
      logger,
    });

    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cannot connect to API: Headers Timeout Error"))
      .mockResolvedValueOnce(new globalThis.Response("ok", { status: 200 }));

    await expect(retryingFetch("https://api.test/v1/chat/completions")).resolves.toMatchObject({
      status: 200,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(logger.event).toHaveBeenCalledWith("ai.http.retry", {
      attempt: 1,
      delay_ms: 0,
      error: "Cannot connect to API: Headers Timeout Error",
      max_retries: 3,
    });
  });

  it("retries 429 provider responses using retry headers", async () => {
    const logger = { event: vi.fn() };
    const retryingFetch = await createRetryingProviderFetch({ logger });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new globalThis.Response("rate limited", {
          headers: { "retry-after-ms": "0" },
          status: 429,
        }),
      )
      .mockResolvedValueOnce(new globalThis.Response("ok", { status: 200 }));

    await expect(retryingFetch("https://api.test/v1/chat/completions")).resolves.toMatchObject({
      status: 200,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(logger.event).toHaveBeenCalledWith("ai.http.retry", {
      attempt: 1,
      delay_ms: 0,
      max_retries: 3,
      status: 429,
    });
    expect(retryDelayMsForHeaders(new globalThis.Headers({ "retry-after": "2" }), 60000)).toBe(
      2000,
    );
  });
});

describe("AI stage runner provider retry delays", () => {
  it("parses alternate retry timing headers and falls back to the default delay", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);

    expect(
      retryDelayMsForHeaders(
        new globalThis.Headers({ "retry-after": new Date(4000).toUTCString() }),
        60000,
      ),
    ).toBe(3000);
    expect(
      retryDelayMsForHeaders(new globalThis.Headers({ "x-ratelimit-reset": "5" }), 60000),
    ).toBe(4000);
    expect(retryDelayMsForHeaders(new globalThis.Headers({ "retry-after": "soon" }), 60000)).toBe(
      60000,
    );
    expect(retryDelayMsForHeaders(undefined, 60000)).toBe(60000);

    now.mockRestore();
  });
});

describe("AI stage runner provider retry limits", () => {
  it("does not retry non-retryable provider responses", async () => {
    const logger = { event: vi.fn() };
    const retryingFetch = await createRetryingProviderFetch({
      config: localProxyConfig({ budgets: { request_retry_delay_seconds: 0 } }),
      logger,
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new globalThis.Response("bad request", { status: 400 }));

    await expect(retryingFetch("https://api.test/v1/chat/completions")).resolves.toMatchObject({
      status: 400,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(logger.event).not.toHaveBeenCalledWith("ai.http.retry", expect.any(Object));
  });

  it("stops retrying provider responses after the configured retry budget", async () => {
    const logger = { event: vi.fn() };
    const retryingFetch = await createRetryingProviderFetch({
      config: localProxyConfig({
        budgets: { request_retry_attempts: 1, request_retry_delay_seconds: 0 },
      }),
      logger,
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new globalThis.Response("rate limited", {
          headers: { "retry-after-ms": "0" },
          status: 429,
        }),
      )
      .mockResolvedValueOnce(new globalThis.Response("still limited", { status: 429 }));

    await expect(retryingFetch("https://api.test/v1/chat/completions")).resolves.toMatchObject({
      status: 429,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(logger.event.mock.calls.filter(([name]) => name === "ai.http.retry")).toHaveLength(1);
  });
});

describe("AI stage runner provider retry error classification", () => {
  it("retries provider errors marked retryable", async () => {
    const logger = { event: vi.fn() };
    const retryingFetch = await createRetryingProviderFetch({
      config: localProxyConfig({ budgets: { request_retry_delay_seconds: 0 } }),
      logger,
    });

    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce({ isRetryable: true })
      .mockResolvedValueOnce(new globalThis.Response("ok", { status: 200 }));

    await expect(retryingFetch("https://api.test/v1/chat/completions")).resolves.toMatchObject({
      status: 200,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(logger.event.mock.calls.filter(([name]) => name === "ai.http.retry")).toHaveLength(1);
  });

  it("does not retry provider errors marked non-retryable", async () => {
    const logger = { event: vi.fn() };
    const retryingFetch = await createRetryingProviderFetch({
      config: localProxyConfig({ budgets: { request_retry_delay_seconds: 0 } }),
      logger,
    });
    const error = { isRetryable: false };
    globalThis.fetch = vi.fn().mockRejectedValueOnce(error);

    await expect(retryingFetch("https://api.test/v1/chat/completions")).rejects.toBe(error);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(logger.event).not.toHaveBeenCalledWith("ai.http.retry", expect.any(Object));
  });
});

describe("AI stage runner telemetry edge cases", () => {
  it("handles OpenAI profiles without a base URL and unknown tool telemetry shapes", async () => {
    delete process.env.GITVIBE_AI_BASE_URL;
    const logger = { event: vi.fn() };
    generateText.mockImplementationOnce(async (request) => {
      request.experimental_onToolCallStart(undefined);
      request.experimental_onToolCallStart({ toolCall: {} });
      request.experimental_onToolCallFinish(undefined);
      request.experimental_onToolCallFinish({ success: false });
      request.onStepFinish(undefined);
      return { text: '{"stage":"summarize","status":"completed"}' };
    });

    await expect(
      runAiStage({
        config: nativeOpenAiConfig(),
        cwd: process.cwd(),
        logger,
        maxTurns: 1,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stage: "investigate",
        stageDefinition: { tools: ["bash-readonly"] },
        system: "System",
      }),
    ).resolves.toBe('{"stage":"summarize","status":"completed"}');

    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: undefined }));
    expect(logger.event).toHaveBeenCalledWith("ai.tool.start", { tool: "<unknown>" });
    expect(logger.event).toHaveBeenCalledWith("ai.tool.failed", {
      error: "undefined",
      tool: "<unknown>",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.step.done", {
      finish_reason: undefined,
      step: 1,
      tool_calls: 0,
      tools: "none",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.request.done", {
      steps: 1,
      tool_calls: 0,
      tools_used: "none",
    });
  });
});

function localProxyConfig({ budgets, model = "glm-5", stage = "investigate" } = {}) {
  return {
    ai: {
      ...(budgets ? { budgets } : {}),
      profiles: {
        local_proxy: {
          provider: {
            ...(model ? { model } : {}),
            type: "openai-compatible",
          },
        },
      },
      stages: { [stage]: { profile: "local_proxy" } },
    },
  };
}

function openAiCompatibleConfig({ stage = "investigate" } = {}) {
  return {
    ai: {
      profiles: {
        test: {
          generation: { temperature: 0.5 },
          provider: {
            api_key_secret: "OPENAI_KEY",
            base_url_variable: "OPENAI_BASE_URL",
            model: "gpt-test",
            type: "openai-compatible",
          },
          provider_options: { custom: true },
        },
      },
      stages: { [stage]: { profile: "test" } },
    },
  };
}

function anthropicConfig() {
  return {
    ai: {
      profiles: {
        claude: {
          provider: {
            api_key_secret: "ANTHROPIC_KEY",
            model: "claude-test",
            type: "anthropic",
          },
        },
      },
      stages: { summarize: { profile: "claude" } },
    },
  };
}

function nativeOpenAiConfig() {
  return {
    ai: {
      profiles: {
        openai: {
          provider: {
            model: "gpt-test",
            type: "openai",
          },
        },
      },
      stages: { investigate: { profile: "openai" } },
    },
  };
}
