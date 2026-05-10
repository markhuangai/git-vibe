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

const { runAiStage } = await import("../src/runner/ai.ts");
const { createStageLogger } = await import("../src/runner/logging.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
  createOpenAI.mockClear();
  createAnthropic.mockClear();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "bundle-secret-value",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    }),
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("AI SDK agentool IO logging", () => {
  it("prints redacted input and output groups by default", testDefaultInputOutputLogging);

  it("prints redacted assistant step text alongside tool call logs", testAssistantStepLogging);
});

async function testDefaultInputOutputLogging() {
  const { logger, messages } = testLogger();
  generateText.mockResolvedValueOnce({
    steps: [
      {
        toolCalls: [
          {
            input: {
              content: '{"stage":"implement","status":"completed","summary":"bundle-secret-value"}',
            },
            toolName: "output_validator",
          },
        ],
      },
    ],
    text: "raw bundle-secret-value",
  });

  await expect(
    runImplementStage({
      logger,
      prompt: `Prompt ${"x".repeat(250)} tail-marker bundle-secret-value`,
      system: "System bundle-secret-value",
    }),
  ).resolves.toContain("bundle-secret-value");

  const log = messages.join("\n");
  expect(log).toContain("::group::[git-vibe] implement ai-sdk-agentool input");
  expect(log).toContain("::group::[git-vibe] implement ai-sdk-agentool output");
  expect(log).toContain("--- system ---");
  expect(log).toContain("--- prompt ---");
  expect(log).toContain("--- raw_text ---");
  expect(log).toContain("--- extracted_json ---");
  expect(log).not.toContain("bundle-secret-value");
  expect(log).not.toContain("tail-marker");
  expect(log).toContain("IO section truncated at 200 chars");
  expect(log).toContain("<redacted:GITVIBE_AI_ENV_JSON.GITVIBE_AI_API_KEY>");
}

async function testAssistantStepLogging() {
  const { logger, messages } = testLogger();
  generateText.mockImplementationOnce(mockGenerateTextWithAssistantStep);

  await runImplementStage({ logger, prompt: "Prompt", system: "System" });

  const log = messages.join("\n");
  expect(log).toContain("ai.tool.start");
  expect(log).toContain("ai.tool.done");
  expect(log).toContain('tool="read"');
  expect(log).toContain("::group::[git-vibe] implement ai-sdk-agentool assistant");
  expect(log).toContain("--- assistant_text ---");
  expect(log).toContain("--- assistant_reasoning ---");
  expect(log).toContain("assistant_text_chars=272");
  expect(log).not.toContain("bundle-secret-value");
  expect(log).not.toContain("tail-marker");
  expect(log).toContain("IO section truncated at 200 chars");
}

async function mockGenerateTextWithAssistantStep(request) {
  request.experimental_onToolCallStart({
    stepNumber: 0,
    toolCall: {
      input: { file_path: "README.md" },
      toolCallId: "tool-1",
      toolName: "read",
    },
  });
  request.experimental_onToolCallFinish({
    durationMs: 2,
    output: "read result",
    stepNumber: 0,
    success: true,
    toolCall: {
      input: { file_path: "README.md" },
      toolCallId: "tool-1",
      toolName: "read",
    },
  });
  request.onStepFinish({
    finishReason: "tool-calls",
    reasoningText: `reasoning bundle-secret-value ${"r".repeat(230)}`,
    text: `assistant bundle-secret-value ${"a".repeat(230)} tail-marker`,
    toolCalls: [{ toolName: "read" }],
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    },
  });
  return {
    steps: [{ toolCalls: [{ toolName: "read" }] }],
    text: '{"stage":"implement","status":"completed"}',
  };
}

function testLogger() {
  const messages = [];
  const logger = createStageLogger("implement", {
    write: (message) => messages.push(message),
  });
  return { logger, messages };
}

async function runImplementStage({ logger, prompt, system }) {
  return runAiStage({
    config: localProxyConfig(),
    cwd: process.cwd(),
    logger,
    maxTurns: 2,
    prompt,
    schema: {},
    schemaId: "implement.v1",
    stage: "implement",
    stageDefinition: stageDefinitions.implement,
    system,
  });
}

function localProxyConfig() {
  return {
    ai: {
      profiles: {
        local_proxy: {
          provider: {
            api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
            base_url: { from_bundle: "GITVIBE_AI_BASE_URL" },
            model: "glm-5",
            type: "openai-compatible",
          },
        },
      },
      stages: { implement: { profile: "local_proxy" } },
    },
  };
}
