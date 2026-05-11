// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));

vi.mock("ai", () => ({
  generateText,
  hasToolCall: vi.fn((toolName) => ({ toolName })),
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));

const { runAiStage } = await import("../src/runner/ai.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
  createOpenAI.mockClear();
  createAnthropic.mockClear();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      ANTHROPIC_KEY: "anthropic-key",
      OPENAI_KEY: "openai-key",
      PROXY_KEY: "proxy-key",
      PROXY_URL: "https://proxy.test/v1",
    }),
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("AI SDK prompt caching", () => {
  it("enables Anthropic cache control by default while preserving explicit options", async () => {
    mockCompletedText("summarize");

    await runAiStage(stageOptions(anthropicConfig(), "summarize"));

    expect(generateText.mock.calls[0][0].providerOptions).toMatchObject({
      anthropic: {
        cacheControl: { type: "ephemeral" },
        effort: "high",
      },
    });
  });

  it("adds a stable prompt cache key for native OpenAI profiles", async () => {
    mockCompletedText("investigate");

    await runAiStage(stageOptions(openAiConfig(), "investigate"));

    expect(generateText.mock.calls[0][0].providerOptions).toMatchObject({
      openai: {
        promptCacheKey: "git-vibe:investigate:investigate.v1:openai",
        reasoningEffort: "high",
      },
    });
  });

  it("does not send OpenAI prompt cache fields to OpenAI-compatible endpoints", async () => {
    mockCompletedText("investigate");

    await runAiStage(stageOptions(openAiCompatibleConfig(), "investigate"));

    expect(generateText.mock.calls[0][0].providerOptions).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  it("rejects malformed provider option namespaces before applying cache defaults", async () => {
    await expect(
      runAiStage(stageOptions(openAiConfig({ openai: "bad" }), "investigate")),
    ).rejects.toThrow("ai.profiles.openai.provider_options.openai must be an object.");
  });
});

function mockCompletedText(stage) {
  const content = JSON.stringify({
    assumptions: [],
    blocking_questions: [],
    comment_body: "Done.",
    findings: [],
    implementation_plan: [],
    next_state: stage === "summarize" ? "ready-for-materialization" : "ready-for-implementation",
    questions: [],
    references: [],
    stage,
    status: "completed",
    summary: "Done.",
  });
  generateText.mockResolvedValueOnce({
    steps: [{ toolCalls: [{ input: { content }, toolName: "output_validator" }] }],
    text: content,
  });
}

function stageOptions(config, stage) {
  return {
    config,
    cwd: process.cwd(),
    maxTurns: 1,
    prompt: "Prompt",
    schema: {},
    schemaId: `${stage}.v1`,
    stage,
    stageDefinition: stageDefinitions[stage],
    system: "System",
  };
}

function anthropicConfig() {
  return {
    ai: {
      profiles: {
        anthropic: {
          provider: {
            api_key: { from_bundle: "ANTHROPIC_KEY" },
            model: "claude-test",
            type: "anthropic",
          },
          provider_options: { anthropic: { effort: "high" } },
        },
      },
      stages: { summarize: { profile: "anthropic" } },
    },
  };
}

function openAiConfig(providerOptions = { openai: { reasoningEffort: "high" } }) {
  return {
    ai: {
      profiles: {
        openai: {
          provider: {
            api_key: { from_bundle: "OPENAI_KEY" },
            model: "gpt-test",
            type: "openai",
          },
          provider_options: providerOptions,
        },
      },
      stages: { investigate: { profile: "openai" } },
    },
  };
}

function openAiCompatibleConfig() {
  return {
    ai: {
      profiles: {
        local_proxy: {
          provider: {
            api_key: { from_bundle: "PROXY_KEY" },
            base_url: { from_bundle: "PROXY_URL" },
            model: "glm-test",
            type: "openai-compatible",
          },
          provider_options: { openai: { reasoningEffort: "high" } },
        },
      },
      stages: { investigate: { profile: "local_proxy" } },
    },
  };
}
