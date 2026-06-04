// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
  connectMcpServer: vi.fn(),
  listMcpTools: vi.fn(),
  mcpResultText: vi.fn((result) =>
    (result.content || []).map((item) => ("text" in item ? item.text : "")).join("\n"),
  ),
  redactMcpText: vi.fn((text, secrets = []) =>
    secrets.reduce((value, secret) => value.split(secret).join("<redacted:mcp-secret>"), text),
  ),
}));

vi.mock("../src/runner/mcp-client.js", () => mocks);

const { buildMcpPromptContext } = await import("../src/runner/mcp-context.ts");

afterEach(() => {
  mocks.callMcpTool.mockReset();
  mocks.connectMcpServer.mockReset();
  mocks.listMcpTools.mockReset();
  mocks.mcpResultText.mockClear();
  mocks.redactMcpText.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("MCP deterministic prompt context", () => {
  it("returns an empty prompt addition when no MCP is configured", async () => {
    await expect(
      buildMcpPromptContext({
        config: { ai: { stages: { "review-matrix": {} } } },
        context: contextPacket(),
        logger: { event: vi.fn() },
        runner: runnerOptions(),
      }),
    ).resolves.toEqual({ promptAddition: "" });
  });

  it("injects allowlisted context call results with rendered arguments", async () => {
    const close = vi.fn();
    mocks.connectMcpServer.mockResolvedValue({
      close,
      server: { name: "dense_mem" },
    });
    mocks.callMcpTool.mockResolvedValue({
      content: [{ text: "remembered decision", type: "text" }],
    });

    const result = await buildMcpPromptContext({
      config: mcpConfig({ required: true }),
      context: contextPacket(),
      logger: { event: vi.fn() },
      runner: runnerOptions(),
    });

    expect(result.blocked).toBeUndefined();
    expect(result.promptAddition).toContain("<mcp_context>");
    expect(result.promptAddition).toContain('"server": "dense_mem"');
    expect(result.promptAddition).toContain('"tool": "recall"');
    expect(result.promptAddition).toContain('"query": "owner/repo#7"');
    expect(result.promptAddition).toContain('"result_text": "remembered decision"');
    expect(mocks.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { query: "owner/repo#7" },
        tool: "recall",
      }),
    );
    expect(close).toHaveBeenCalled();
  });

  it("truncates large deterministic MCP context results", async () => {
    mocks.connectMcpServer.mockResolvedValue({
      close: vi.fn(),
      server: { name: "dense_mem" },
    });
    mocks.callMcpTool.mockResolvedValue({
      content: [{ text: "x".repeat(50_100), type: "text" }],
    });

    const result = await buildMcpPromptContext({
      config: mcpConfig({ required: true }),
      context: contextPacket(),
      logger: { event: vi.fn() },
      runner: runnerOptions(),
    });

    expect(result.promptAddition).toContain("[MCP result truncated to 50000 characters]");
  });
});

describe("MCP deterministic prompt context failures", () => {
  it("blocks required MCP context failures with a stage-shaped output", async () => {
    const logger = { event: vi.fn() };
    mocks.connectMcpServer.mockRejectedValue(new Error("offline"));

    const result = await buildMcpPromptContext({
      config: mcpConfig({ required: true }),
      context: contextPacket(),
      logger,
      runner: runnerOptions(),
    });

    expect(result.promptAddition).toBe("");
    expect(result.blocked).toMatchObject({
      inline_comments: [],
      next_state: "blocked",
      stage: "review-matrix",
      status: "blocked",
      tests: [],
    });
    expect(result.blocked.comment_body).toContain("MCP server dense_mem failed: offline");
    expect(logger.event).toHaveBeenCalledWith("mcp.context.block", {
      reason: "MCP server dense_mem failed: offline",
    });
  });

  it("blocks required MCP context call errors", async () => {
    mocks.connectMcpServer.mockResolvedValue({
      close: vi.fn(),
      server: { name: "dense_mem" },
    });
    mocks.callMcpTool.mockResolvedValue({
      content: [{ text: "tool denied", type: "text" }],
      isError: true,
    });

    const result = await buildMcpPromptContext({
      config: mcpConfig({ required: true }),
      context: contextPacket(),
      logger: { event: vi.fn() },
      runner: runnerOptions(),
    });

    expect(result.blocked.comment_body).toContain(
      "MCP context call dense_mem.recall failed: tool denied",
    );
  });

  it("keeps optional MCP context failures as warnings", async () => {
    const logger = { event: vi.fn() };
    mocks.callMcpTool.mockResolvedValue({
      content: [{ text: "tool denied", type: "text" }],
      isError: true,
    });
    mocks.connectMcpServer.mockResolvedValue({
      close: vi.fn(),
      server: { name: "dense_mem" },
    });

    const result = await buildMcpPromptContext({
      config: mcpConfig({ required: false }),
      context: contextPacket(),
      logger,
      runner: runnerOptions(),
    });

    expect(result.blocked).toBeUndefined();
    expect(result.promptAddition).toContain('"warnings"');
    expect(result.promptAddition).toContain(
      "MCP context call dense_mem.recall failed: tool denied",
    );
    expect(logger.event).toHaveBeenCalledWith("mcp.context.warning", {
      reason: "MCP context call dense_mem.recall failed: tool denied",
    });
  });
});

describe("MCP deterministic prompt context secret handling", () => {
  it("redacts MCP secrets from required connection failures before publishing", async () => {
    const logger = { event: vi.fn() };
    vi.stubEnv("GITVIBE_MCP_ENV_JSON", JSON.stringify({ DENSE_MEM_TOKEN: "dense-token" }));
    mocks.connectMcpServer.mockRejectedValue(new Error("dense-token offline"));

    const result = await buildMcpPromptContext({
      config: secretMcpConfig({ required: true }),
      context: contextPacket(),
      logger,
      runner: runnerOptions(),
    });

    expect(result.blocked.comment_body).not.toContain("dense-token");
    expect(result.blocked.comment_body).toContain(
      "MCP server dense_mem failed: <redacted:mcp-secret> offline",
    );
    expect(logger.event).toHaveBeenCalledWith("mcp.context.block", {
      reason: "MCP server dense_mem failed: <redacted:mcp-secret> offline",
    });
  });

  it("warns instead of throwing when optional MCP credentials are missing", async () => {
    const logger = { event: vi.fn() };
    vi.stubEnv("GITVIBE_MCP_ENV_JSON", "{}");

    const result = await buildMcpPromptContext({
      config: secretMcpConfig({ required: false }),
      context: contextPacket(),
      logger,
      runner: runnerOptions(),
    });

    expect(result.blocked).toBeUndefined();
    expect(result.promptAddition).toContain("GITVIBE_MCP_ENV_JSON key DENSE_MEM_TOKEN is required");
    expect(logger.event).toHaveBeenCalledWith("mcp.context.warning", {
      reason: expect.stringContaining("GITVIBE_MCP_ENV_JSON key DENSE_MEM_TOKEN is required"),
    });
    expect(mocks.connectMcpServer).not.toHaveBeenCalled();
  });
});

describe("MCP model tool preflight", () => {
  it("blocks required model-only MCP servers before the model runs", async () => {
    const logger = { event: vi.fn() };
    mocks.connectMcpServer.mockRejectedValue(new Error("offline"));

    const result = await buildMcpPromptContext({
      config: modelMcpConfig({ required: true }),
      context: contextPacket(),
      logger,
      runner: runnerOptions(),
    });

    expect(result.promptAddition).toBe("");
    expect(result.blocked).toMatchObject({
      next_state: "blocked",
      stage: "review-matrix",
      status: "blocked",
    });
    expect(result.blocked.comment_body).toContain("MCP server dense_mem failed: offline");
  });

  it("warns and continues for optional model-only MCP servers", async () => {
    const logger = { event: vi.fn() };
    mocks.connectMcpServer.mockRejectedValue(new Error("offline"));

    const result = await buildMcpPromptContext({
      config: modelMcpConfig({ required: false }),
      context: contextPacket(),
      logger,
      runner: runnerOptions(),
    });

    expect(result).toEqual({ promptAddition: expect.stringContaining('"warnings"') });
    expect(result.promptAddition).toContain("MCP server dense_mem failed: offline");
    expect(logger.event).toHaveBeenCalledWith("mcp.context.warning", {
      reason: "MCP server dense_mem failed: offline",
    });
  });

  it("preflights available model tools without adding prompt context", async () => {
    mocks.connectMcpServer.mockResolvedValue({
      close: vi.fn(),
      server: { name: "dense_mem" },
    });
    mocks.listMcpTools.mockResolvedValue({ tools: [{ name: "search_memory" }] });

    await expect(
      buildMcpPromptContext({
        config: modelMcpConfig({ required: true }),
        context: contextPacket(),
        logger: { event: vi.fn() },
        runner: runnerOptions(),
      }),
    ).resolves.toEqual({ promptAddition: "" });
  });

  it("renders non-Error optional model preflight failures as warnings", async () => {
    const logger = { event: vi.fn() };
    mocks.connectMcpServer.mockResolvedValue({
      close: vi.fn(),
      server: { name: "dense_mem" },
    });
    mocks.listMcpTools.mockRejectedValue("offline");

    const result = await buildMcpPromptContext({
      config: modelMcpConfig({ required: false }),
      context: contextPacket(),
      logger,
      runner: runnerOptions(),
    });

    expect(result.promptAddition).toContain("MCP server dense_mem failed: offline");
  });

  it("blocks when required model tools are missing from the MCP server", async () => {
    mocks.connectMcpServer.mockResolvedValue({
      close: vi.fn(),
      server: { name: "dense_mem" },
    });
    mocks.listMcpTools.mockResolvedValue({ tools: [] });

    const result = await buildMcpPromptContext({
      config: modelMcpConfig({ required: true }),
      context: contextPacket(),
      logger: { event: vi.fn() },
      runner: runnerOptions(),
    });

    expect(result.blocked.comment_body).toContain(
      "MCP server dense_mem failed: missing allowed model tools on dense_mem: search_memory",
    );
  });
});

function mcpConfig({ required }) {
  return {
    ai: {
      mcp: {
        servers: {
          dense_mem: {
            command: "node",
          },
        },
      },
      stages: {
        "review-matrix": {
          mcp: {
            dense_mem: {
              allow_tools: {
                context: ["recall"],
              },
              context_calls: [
                { arguments: { query: "{{repository}}#{{pr_number}}" }, tool: "recall" },
              ],
              required,
            },
          },
        },
      },
    },
  };
}

function modelMcpConfig({ required }) {
  return {
    ai: {
      mcp: {
        servers: {
          dense_mem: {
            command: "node",
          },
        },
      },
      stages: {
        "review-matrix": {
          mcp: {
            dense_mem: {
              tools: ["search_memory"],
              required,
            },
          },
        },
      },
    },
  };
}

function secretMcpConfig({ required }) {
  const config = mcpConfig({ required });
  config.ai.mcp.servers.dense_mem.env = {
    DENSE_MEM_TOKEN: { from_bundle: "DENSE_MEM_TOKEN" },
  };
  return config;
}

function contextPacket() {
  return {
    artifact: {
      number: "7",
      title: "Review me",
      type: "pull_request",
      url: "https://github.com/owner/repo/pull/7",
    },
    repository: "owner/repo",
  };
}

function runnerOptions() {
  return {
    dryRun: false,
    executionMode: "maintainer",
    prNumber: "7",
    stage: "review-matrix",
    workflowRunUrl: "https://github.com/owner/repo/actions/runs/1",
  };
}
