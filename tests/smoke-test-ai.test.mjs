import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  aiEnvBundle,
  booleanEnv,
  buildPrompt,
  countToolCalls,
  countToolCallsByName,
  extractJsonObject,
  isDirectRun,
  main,
  numberEnv,
  outputContent,
  outputValidatorContent,
  parseSmokeOutput,
  readConfig,
  requiredBundledEnv,
  requiredEnv,
  runSmokeTest,
  validateOutput,
} from "../scripts/smoke-test-ai.mjs";

const baseEnv = {
  GITVIBE_AI_ENV_JSON: JSON.stringify({
    GITVIBE_AI_API_KEY: "secret-key",
    GITVIBE_AI_BASE_URL: "http://proxy.local/v1",
  }),
};

describe("smoke-test-ai config", () => {
  it("reads required variables, defaults, and workspace cwd", () => {
    expect(readConfig({ cwd: "/repo", env: baseEnv, workspace: "/workspace" })).toMatchObject({
      apiKey: "secret-key",
      baseUrl: "http://proxy.local/v1",
      cwd: "/workspace",
      maxOutputTokens: 1000,
      maxSteps: 4,
      model: "glm-5",
      requireTool: true,
    });
    expect(
      readConfig({
        cwd: "/repo",
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            GITVIBE_AI_API_KEY: "secret-key",
            GITVIBE_AI_BASE_URL: "http://proxy.local/v1",
          }),
        },
      }).model,
    ).toBe("glm-5");
  });

  it("parses optional numeric and boolean environment values", () => {
    const env = {
      ...baseEnv,
      GITVIBE_AI_MAX_OUTPUT_TOKENS: "1500",
      GITVIBE_AI_SMOKE_MAX_STEPS: "7",
      GITVIBE_AI_SMOKE_REQUIRE_TOOL: "false",
    };

    expect(readConfig({ cwd: "/repo", env })).toMatchObject({
      maxOutputTokens: 1500,
      maxSteps: 7,
      requireTool: false,
    });
  });

  it("throws clear config errors", () => {
    expect(() => requiredEnv({}, "GITVIBE_AI_ENV_JSON")).toThrow(
      "GITVIBE_AI_ENV_JSON is required.",
    );
    expect(() => aiEnvBundle({ GITVIBE_AI_ENV_JSON: "{" })).toThrow(
      "GITVIBE_AI_ENV_JSON must be valid JSON",
    );
    expect(() => aiEnvBundle({ GITVIBE_AI_ENV_JSON: "[]" })).toThrow(
      "GITVIBE_AI_ENV_JSON must be a JSON object.",
    );
    expect(() => aiEnvBundle({ GITVIBE_AI_ENV_JSON: JSON.stringify({ KEY: 1 }) })).toThrow(
      "GITVIBE_AI_ENV_JSON.KEY must be a string.",
    );
    expect(() => requiredBundledEnv({}, "GITVIBE_AI_API_KEY")).toThrow(
      "GITVIBE_AI_ENV_JSON.GITVIBE_AI_API_KEY is required.",
    );
    expect(() => numberEnv({ VALUE: "0" }, "VALUE", 1)).toThrow("VALUE must be a positive number.");
    expect(booleanEnv({}, "FLAG", true)).toBe(true);
    expect(booleanEnv({ FLAG: "true" }, "FLAG", false)).toBe(true);
  });
});

describe("smoke-test-ai runner", () => {
  it("calls AI SDK with an agentool read tool and returns a report", async () => {
    const dependencies = createDependencies({
      triggerTool: true,
    });

    const report = await runSmokeTest({
      cwd: "/repo",
      dependencies,
      env: baseEnv,
      workspace: "/workspace",
    });

    expect(dependencies.createOpenAI).toHaveBeenCalledWith({
      apiKey: "secret-key",
      baseURL: "http://proxy.local/v1",
      name: "git-vibe-local-proxy",
    });
    expect(dependencies.createRead).toHaveBeenCalledWith({ cwd: "/workspace" });
    expect(dependencies.createOutputValidator).toHaveBeenCalledWith(
      expect.objectContaining({ schemaId: "git-vibe-smoke.v1" }),
    );
    expect(dependencies.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 1000,
        maxRetries: 0,
        prompt: expect.stringContaining("Use the read tool"),
        temperature: 0,
      }),
    );
    expect(report).toMatchObject({
      model: "glm-5",
      observedAgentoolSpecifier: "^1.4.0",
      packageName: "git-vibe",
      toolCallCount: 2,
      toolEvents: ["read", "output_validator"],
    });
  });

  it("allows smoke testing models that cannot call tools", async () => {
    const dependencies = createDependencies({ steps: [{ toolCalls: [] }] });
    const report = await runSmokeTest({
      cwd: "/repo",
      dependencies,
      env: { ...baseEnv, GITVIBE_AI_SMOKE_REQUIRE_TOOL: "false" },
    });

    expect(dependencies.createRead).not.toHaveBeenCalled();
    expect(report.toolCallCount).toBe(0);
    expect(buildPrompt(false)).toContain("without tools");
  });
});

describe("smoke-test-ai validation", () => {
  it("rejects unsuccessful output and missing required tool calls", async () => {
    expect(() =>
      validateOutput({
        config: { requireTool: false },
        output: { ok: false, summary: "not ready" },
        outputValidatorCallCount: 0,
        readToolCallCount: 0,
      }),
    ).toThrow("local proxy returned ok=false: not ready");

    expect(() =>
      validateOutput({
        config: { requireTool: true },
        output: { ok: true, summary: "ok" },
        outputValidatorCallCount: 1,
        readToolCallCount: 0,
      }),
    ).toThrow("did not call the agentool read tool");

    expect(() =>
      validateOutput({
        config: { requireTool: true },
        output: { ok: true, summary: "ok" },
        outputValidatorCallCount: 0,
        readToolCallCount: 1,
      }),
    ).toThrow("did not call output_validator");
  });

  it("wraps CLI success and failure with stable exit codes", async () => {
    const logger = { error: vi.fn(), log: vi.fn() };
    const success = await main({
      cwd: "/repo",
      dependencies: createDependencies(),
      env: baseEnv,
      logger,
    });
    const failure = await main({
      cwd: "/repo",
      dependencies: createDependencies(),
      env: {},
      logger,
    });

    expect(success).toBe(0);
    expect(failure).toBe(1);
    expect(logger.log).toHaveBeenCalledWith("[git-vibe] local proxy smoke passed with model=glm-5");
    expect(logger.error).toHaveBeenCalledWith("[git-vibe] GITVIBE_AI_ENV_JSON is required.");
  });
});

describe("smoke-test-ai helpers", () => {
  it("counts tool calls and detects direct execution", () => {
    const result = {
      steps: [{ toolCalls: [{ toolName: "read" }, { toolName: "output_validator" }] }],
      text: "{}",
    };

    expect(countToolCalls(result)).toBe(2);
    expect(countToolCallsByName(result, "read")).toBe(1);
    expect(
      isDirectRun(new URL("../scripts/smoke-test-ai.mjs", import.meta.url).href, undefined),
    ).toBe(false);
    expect(
      isDirectRun(
        new URL("../scripts/smoke-test-ai.mjs", import.meta.url).href,
        fileURLToPath(new URL("../scripts/smoke-test-ai.mjs", import.meta.url)),
      ),
    ).toBe(true);
  });

  it("extracts and validates JSON text output", () => {
    const json = JSON.stringify({
      observedAgentoolSpecifier: "^1.4.0",
      ok: true,
      packageName: "git-vibe",
      source: "local-proxy",
      summary: "ok",
    });

    expect(extractJsonObject(`\`\`\`json\n${json}\n\`\`\``)).toBe(json);
    expect(parseSmokeOutput(`The result is ${json}`)).toMatchObject({
      packageName: "git-vibe",
      source: "local-proxy",
    });
    expect(() => parseSmokeOutput("{}")).toThrow("did not match schema");
    expect(() => extractJsonObject("not json")).toThrow("did not contain a JSON object");
  });

  it("prefers validated output from the output_validator tool input", () => {
    const json = JSON.stringify({
      observedAgentoolSpecifier: "^1.4.0",
      ok: true,
      packageName: "git-vibe",
      source: "local-proxy",
      summary: "ok",
    });
    const result = {
      steps: [{ toolCalls: [{ input: { content: json }, toolName: "output_validator" }] }],
      text: "{}",
    };

    expect(outputValidatorContent(result)).toBe(json);
    expect(outputContent(result, { requireTool: true })).toBe(json);
    expect(() => outputContent({ steps: [], text: json }, { requireTool: true })).toThrow(
      "did not call output_validator",
    );
  });
});

/**
 * @param {{ output?: any, steps?: Array<{ toolCalls: Array<{ input?: unknown, toolName?: string }> }>, triggerTool?: boolean }} [options]
 * @returns {any}
 */
function createDependencies({ output, steps, triggerTool = false } = {}) {
  const resultOutput = output ?? {
    observedAgentoolSpecifier: "^1.4.0",
    ok: true,
    packageName: "git-vibe",
    source: "local-proxy",
    summary: "ok",
  };
  const resolvedSteps = steps ?? [
    {
      toolCalls: [
        { toolName: "read" },
        { input: { content: JSON.stringify(resultOutput) }, toolName: "output_validator" },
      ],
    },
  ];
  const provider = { chat: vi.fn((model) => ({ model })) };
  const dependencies = {
    createOpenAI: vi.fn(() => provider),
    createOutputValidator: vi.fn(() => ({ description: "output validator" })),
    createRead: vi.fn(() => ({ description: "read" })),
    generateText: vi.fn(async (options) => {
      if (triggerTool) {
        options.experimental_onToolCallStart({ toolCall: { toolName: "read" } });
        options.experimental_onToolCallStart({ toolCall: { toolName: "output_validator" } });
      }

      return { steps: resolvedSteps, text: JSON.stringify(resultOutput) };
    }),
    stepCountIs: vi.fn((stepsCount) => `steps:${stepsCount}`),
  };

  return /** @type {any} */ (dependencies);
}
