// @ts-nocheck
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAiStage } from "../src/runner/ai.ts";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Codex and Claude SDK adapter routing", () => {
  it("runs codex-sdk profiles and validates structured output", async () => {
    const cwd = workspace();
    process.env.CODEX_HOME = join(cwd, "ambient-codex-home");
    const output = await runAiStage(stageOptions({ cwd, config: codexConfig() }));

    expect(JSON.parse(output)).toMatchObject({
      next_state: "ready-for-implementation",
      stage: "validate",
    });
    const constructorOptions = globalThis.__gitVibeSdkMocks.codexConstructor.mock.calls[0][0];
    expect(globalThis.__gitVibeSdkMocks.codexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        env: expect.any(Object),
      }),
    );
    expect(constructorOptions.env.CODEX_HOME).toContain("git-vibe-codex-");
    expect(constructorOptions.env.CODEX_HOME).not.toBe(process.env.CODEX_HOME);
    expect(existsSync(constructorOptions.env.CODEX_HOME)).toBe(false);
    expect(globalThis.__gitVibeSdkMocks.codexStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "never",
        model: "gpt-5-test",
        modelReasoningEffort: "high",
        sandboxMode: "danger-full-access",
        workingDirectory: cwd,
      }),
    );
  });

  it("runs claude-code-sdk profiles with env bundle values and custom system prompt", async () => {
    const cwd = workspace();
    process.env.GITVIBE_AI_ENV_JSON = JSON.stringify({
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      GITVIBE_AI_API_KEY: "test-key",
    });
    const output = await runAiStage(stageOptions({ cwd, config: claudeConfig() }));

    expect(JSON.parse(output)).toMatchObject({
      next_state: "ready-for-implementation",
      stage: "validate",
    });
    expect(globalThis.__gitVibeSdkMocks.claudeQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          allowDangerouslySkipPermissions: true,
          cwd,
          effort: "max",
          env: expect.objectContaining({
            ANTHROPIC_API_KEY: "test-key",
            ANTHROPIC_BASE_URL: "https://anthropic.example",
          }),
          model: "opus",
          permissionMode: "bypassPermissions",
          persistSession: false,
          settingSources: [],
          systemPrompt: expect.stringContaining("System"),
        }),
        prompt: "Prompt",
      }),
    );
  });
});

describe("Codex SDK adapter logging", () => {
  it("logs Codex SDK item variants and supports reasoning summaries without effort", async () => {
    const cwd = workspace();
    const logger = { event: vi.fn() };
    const output = validValidateOutput({ summary: "Logged." });
    globalThis.__gitVibeSdkMocks.queueCodexResult({
      finalResponse: JSON.stringify(output),
      items: [
        {
          command: `echo ${"x".repeat(180)}`,
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
        {
          error: { message: "dense token leaked" },
          server: "dense_mem",
          status: "failed",
          tool: "search_memory",
          type: "mcp_tool_call",
        },
        {
          server: "dense_mem",
          status: "completed",
          tool: "search_memory",
          type: "mcp_tool_call",
        },
        { text: "Agent replied.", type: "agent_message" },
        { text: "Reasoning trace.", type: "reasoning" },
        { changes: [{ path: "README.md" }], status: "done", type: "file_change" },
        { message: "tool failed with token", type: "error" },
        { type: "custom_item" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    await runAiStage(
      stageOptions({
        config: codexConfig({ reasoning: { summary: "concise" } }),
        cwd,
        logger,
      }),
    );

    expect(globalThis.__gitVibeSdkMocks.codexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { model_reasoning_summary: "concise" },
      }),
    );
    expect(globalThis.__gitVibeSdkMocks.codexStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ modelReasoningEffort: undefined }),
    );
    expect(logger.event.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "ai.codex.command",
        "ai.codex.mcp_tool",
        "ai.codex.message",
        "ai.codex.reasoning",
        "ai.codex.file_change",
        "ai.codex.error",
        "ai.codex.item",
      ]),
    );
  });
});

describe("Claude SDK adapter logging", () => {
  it("logs Claude SDK message variants and validates result text fallback", async () => {
    const cwd = workspace();
    const logger = { event: vi.fn() };
    globalThis.__gitVibeSdkMocks.queueClaudeMessages([
      {
        claude_code_version: "test",
        model: "opus",
        permissionMode: "bypassPermissions",
        subtype: "init",
        tools: ["mcp__dense_mem__search_memory"],
        type: "system",
      },
      {
        attempt: 2,
        error: "rate limited",
        error_status: 429,
        retry_delay_ms: 123.4,
        subtype: "api_retry",
        type: "system",
      },
      {
        message: {
          content: [
            { text: "y".repeat(200), type: "text" },
            { thinking: "plan", type: "thinking" },
            { input: { file_path: "README.md" }, name: "Read", type: "tool_use" },
            { input: { command: `echo ${"z".repeat(180)}` }, name: "Bash", type: "tool_use" },
            { input: { a: 1, b: 2, c: 3 }, name: "Inspect", type: "tool_use" },
            { input: undefined, name: undefined, type: "tool_use" },
          ],
        },
        type: "assistant",
      },
      { message: { content: [] }, type: "assistant" },
      { message: null, type: "assistant" },
      {
        duration_ms: 5,
        is_error: true,
        num_turns: 2,
        result: JSON.stringify(validValidateOutput({ summary: "Claude text." })),
        stop_reason: "stop",
        subtype: "success",
        type: "result",
      },
    ]);

    const output = await runAiStage(
      stageOptions({
        config: claudeConfig({ env: undefined, reasoning: undefined }),
        cwd,
        logger,
      }),
    );

    expect(JSON.parse(output)).toMatchObject({ summary: "Claude text." });
    expect(logger.event.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "ai.claude.init",
        "ai.claude.retry",
        "ai.claude.message",
        "ai.claude.thinking",
        "ai.claude.tool",
        "ai.claude.assistant",
        "ai.claude.result",
      ]),
    );
  });
});

describe("Codex and Claude SDK adapter validation", () => {
  it("fails fast for unsupported SDK reasoning efforts and failed Claude results", async () => {
    const cwd = workspace();
    await expect(
      runAiStage(
        stageOptions({
          config: codexConfig({ reasoning: { effort: "turbo" } }),
          cwd,
        }),
      ),
    ).rejects.toThrow("reasoning.effort is not supported by codex-sdk: turbo");

    await expect(
      runAiStage(
        stageOptions({
          config: claudeConfig({ env: undefined, reasoning: { effort: "turbo" } }),
          cwd,
        }),
      ),
    ).rejects.toThrow("reasoning.effort is not supported by claude-code-sdk: turbo");

    globalThis.__gitVibeSdkMocks.queueClaudeMessages([
      { errors: ["boom"], subtype: "error_during_execution", type: "result" },
    ]);
    await expect(
      runAiStage(
        stageOptions({
          config: claudeConfig({ env: undefined, reasoning: undefined }),
          cwd,
        }),
      ),
    ).rejects.toThrow("Claude Code SDK failed: boom");

    globalThis.__gitVibeSdkMocks.queueClaudeMessages([
      { errors: [], subtype: "error_during_execution", type: "result" },
    ]);
    await expect(
      runAiStage(
        stageOptions({
          config: claudeConfig({ env: undefined, reasoning: undefined }),
          cwd,
        }),
      ),
    ).rejects.toThrow("Claude Code SDK failed: error_during_execution");

    globalThis.__gitVibeSdkMocks.queueClaudeMessages([
      { subtype: "error_during_execution", type: "result" },
    ]);
    await expect(
      runAiStage(
        stageOptions({
          config: claudeConfig({ env: undefined, reasoning: undefined }),
          cwd,
        }),
      ),
    ).rejects.toThrow("Claude Code SDK failed: error_during_execution");
  });
});

describe("SDK adapter config validation", () => {
  it("requires explicit profile adapters", async () => {
    const cwd = workspace();
    await expect(
      runAiStage(
        stageOptions({
          cwd,
          config: {
            ai: {
              profiles: { test: { model: "gpt-5-test" } },
              stages: { validate: { profile: "test" } },
            },
          },
        }),
      ),
    ).rejects.toThrow("ai.profiles.test.adapter must be configured.");
  });

  it("validates stage enabled flags and unsupported adapters", async () => {
    const cwd = workspace();
    await expect(
      runAiStage(stageOptions({ cwd, config: codexConfig({ stage: { enabled: false } }) })),
    ).rejects.toThrow("ai.stages.validate is disabled.");
    await expect(
      runAiStage(stageOptions({ cwd, config: codexConfig({ stage: { enabled: "yes" } }) })),
    ).rejects.toThrow("ai.stages.validate.enabled must be a boolean.");
    await expect(
      runAiStage(stageOptions({ cwd, config: legacyConfig("custom-sdk") })),
    ).rejects.toThrow("AI profile test uses unsupported adapter custom-sdk.");
  });
});

describe("SDK MCP config", () => {
  it("passes stage MCP gateway config to Codex SDK", async () => {
    const cwd = workspace();
    process.env.GITHUB_ACTION_PATH = join(cwd, "action");
    process.env.GITVIBE_MCP_ENV_JSON = JSON.stringify({ DENSE_TOKEN: "secret-token" });
    let gatewayContent;
    globalThis.__gitVibeSdkMocks.codexRun.mockImplementationOnce(async () => {
      const constructorOptions = globalThis.__gitVibeSdkMocks.codexConstructor.mock.calls[0][0];
      const gatewayPath =
        constructorOptions.config.mcp_servers.dense_mem.env.GITVIBE_MCP_GATEWAY_CONFIG;
      gatewayContent = JSON.parse(readFileSync(gatewayPath, "utf8"));
      return {
        finalResponse: JSON.stringify(validValidateOutput()),
        items: [],
        usage: {},
      };
    });
    await runAiStage(stageOptions({ cwd, config: codexConfigWithMcp() }));

    const constructorOptions = globalThis.__gitVibeSdkMocks.codexConstructor.mock.calls[0][0];
    expect(constructorOptions.config.mcp_servers.dense_mem).toMatchObject({
      command: process.execPath,
      enabled: true,
      enabled_tools: ["search_memory"],
      args: [join(cwd, "dist/actions/mcp-gateway.js")],
      required: true,
      tools: { search_memory: { approval_mode: "approve" } },
    });
    const gatewayPath =
      constructorOptions.config.mcp_servers.dense_mem.env.GITVIBE_MCP_GATEWAY_CONFIG;
    expect(gatewayContent).toMatchObject({
      allowTools: ["search_memory"],
      required: true,
      server: {
        args: ["server.js"],
        command: "node",
        name: "dense_mem",
        transport: "stdio",
      },
    });
    expect(existsSync(gatewayPath)).toBe(false);
  });

  it("passes stage MCP gateway config to Claude SDK", async () => {
    const cwd = workspace();
    process.env.GITVIBE_AI_ENV_JSON = JSON.stringify({
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      GITVIBE_AI_API_KEY: "test-key",
    });
    process.env.GITVIBE_MCP_ENV_JSON = JSON.stringify({ DENSE_TOKEN: "secret-token" });
    let gatewayContent;
    globalThis.__gitVibeSdkMocks.claudeQuery.mockImplementationOnce(async function* (params) {
      const gatewayPath = params.options.mcpServers.dense_mem.env.GITVIBE_MCP_GATEWAY_CONFIG;
      gatewayContent = JSON.parse(readFileSync(gatewayPath, "utf8"));
      yield {
        duration_ms: 1,
        is_error: false,
        num_turns: 1,
        result: JSON.stringify(validValidateOutput()),
        stop_reason: "stop",
        structured_output: validValidateOutput(),
        subtype: "success",
        type: "result",
      };
    });
    await runAiStage(stageOptions({ cwd, config: claudeConfigWithMcp() }));

    const queryOptions = globalThis.__gitVibeSdkMocks.claudeQuery.mock.calls[0][0].options;
    expect(queryOptions.allowedTools).toEqual(["mcp__dense_mem__search_memory"]);
    expect(queryOptions.strictMcpConfig).toBe(true);
    expect(queryOptions.mcpServers.dense_mem).toMatchObject({
      alwaysLoad: true,
      command: process.execPath,
      type: "stdio",
    });
    const gatewayPath = queryOptions.mcpServers.dense_mem.env.GITVIBE_MCP_GATEWAY_CONFIG;
    expect(gatewayContent).toMatchObject({
      allowTools: ["search_memory"],
      required: true,
    });
    expect(existsSync(gatewayPath)).toBe(false);
  });
});

describe("SDK MCP config warnings", () => {
  it("warns and leaves SDK MCP config empty for optional unresolved model servers", async () => {
    const cwd = workspace();
    const logger = { event: vi.fn() };
    await runAiStage(
      stageOptions({
        config: optionalBrokenMcpConfig(),
        cwd,
        logger,
      }),
    );

    expect(globalThis.__gitVibeSdkMocks.codexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ config: {} }),
    );
    expect(logger.event).toHaveBeenCalledWith("mcp.sdk_config.warning", {
      reason: "ai.mcp.servers.dense_mem.command must be configured for stdio MCP servers.",
      server: "dense_mem",
    });
  });
});

function stageOptions({ config, cwd, logger }) {
  return {
    config,
    cwd,
    logger,
    maxTurns: 3,
    prompt: "Prompt",
    schema: validateSchema(),
    schemaId: "validate.v1",
    stage: "validate",
    stageDefinition: { schemaFile: "validate.v1.schema.json", schemaId: "validate.v1" },
    system: "System",
  };
}

function codexConfig(overrides = {}) {
  const { stage, ...profileOverrides } = overrides;
  return {
    ai: {
      profiles: {
        test: {
          adapter: "codex-sdk",
          model: "gpt-5-test",
          reasoning: { effort: "high" },
          ...profileOverrides,
        },
      },
      stages: { validate: { profile: "test", ...stage } },
    },
  };
}

function claudeConfig(overrides = {}) {
  return {
    ai: {
      profiles: {
        test: {
          adapter: "claude-code-sdk",
          env: {
            ANTHROPIC_API_KEY: { from_bundle: "GITVIBE_AI_API_KEY" },
            ANTHROPIC_BASE_URL: { from_bundle: "ANTHROPIC_BASE_URL" },
          },
          model: "opus",
          reasoning: { effort: "max" },
          ...overrides,
        },
      },
      stages: { validate: { profile: "test" } },
    },
  };
}

function legacyConfig(adapter) {
  return {
    ai: {
      profiles: { test: { adapter, model: "legacy" } },
      stages: { validate: { profile: "test" } },
    },
  };
}

function codexConfigWithMcp() {
  return withMcp(codexConfig());
}

function claudeConfigWithMcp() {
  return withMcp(claudeConfig());
}

function withMcp(config) {
  return {
    ai: {
      ...config.ai,
      mcp: {
        servers: {
          dense_mem: {
            args: ["server.js"],
            command: "node",
            env: { DENSE_TOKEN: { from_bundle: "DENSE_TOKEN" } },
            transport: "stdio",
          },
        },
      },
      stages: {
        validate: {
          mcp: {
            dense_mem: {
              required: true,
              tools: ["search_memory"],
            },
          },
          profile: "test",
        },
      },
    },
  };
}

function optionalBrokenMcpConfig() {
  const config = codexConfig();
  return {
    ai: {
      ...config.ai,
      mcp: {
        servers: {
          dense_mem: {
            transport: "stdio",
          },
        },
      },
      stages: {
        validate: {
          mcp: {
            dense_mem: {
              required: false,
              tools: ["search_memory"],
            },
          },
          profile: "test",
        },
      },
    },
  };
}

function validateSchema() {
  return JSON.parse(
    readFileSync(join(process.cwd(), "schemas/stages/validate.v1.schema.json"), "utf8"),
  );
}

function validValidateOutput(overrides = {}) {
  return {
    assumptions: [],
    comment_body: "Ready.",
    findings: [],
    next_state: "ready-for-implementation",
    references: [],
    stage: "validate",
    status: "completed",
    summary: "Ready.",
    ...overrides,
  };
}

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-sdk-adapters-"));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), "version: 1\n");
  return cwd;
}
