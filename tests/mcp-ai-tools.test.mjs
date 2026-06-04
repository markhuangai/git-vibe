// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
  connectMcpServer: vi.fn(),
  mcpResultText: vi.fn(),
  redactMcpText: vi.fn((text, secrets = []) =>
    secrets.reduce((value, secret) => value.split(secret).join("<redacted:mcp-secret>"), text),
  ),
}));

vi.mock("../src/runner/mcp-client.js", () => mocks);

const { createMcpAiTools, namespacedToolName } = await import("../src/runner/mcp-ai-tools.ts");

afterEach(() => {
  mocks.callMcpTool.mockReset();
  mocks.connectMcpServer.mockReset();
  mocks.mcpResultText.mockReset();
  mocks.redactMcpText.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AI SDK MCP tools", () => {
  it("exposes only stage-allowlisted MCP model tools", async () => {
    const close = vi.fn();
    const listTools = vi.fn().mockResolvedValue({
      tools: [
        {
          description: "Search memory",
          inputSchema: { properties: { query: { type: "string" } }, type: "object" },
          name: "search_memory",
        },
        {
          inputSchema: { type: "object" },
          name: "write_memory",
        },
      ],
    });
    mocks.connectMcpServer.mockResolvedValue({
      client: { listTools },
      close,
      server: { name: "dense_mem" },
    });
    mocks.callMcpTool.mockResolvedValue({
      content: [{ text: "memory result", type: "text" }],
    });
    mocks.mcpResultText.mockReturnValue("memory result");
    const logger = { event: vi.fn() };

    const result = await createMcpAiTools({
      config: mcpConfig(),
      logger,
      stage: "validate",
    });

    expect(Object.keys(result.tools)).toEqual(["mcp__dense_mem__search_memory"]);
    expect(namespacedToolName("dense_mem", "search_memory")).toBe("mcp__dense_mem__search_memory");
    await expect(
      result.tools.mcp__dense_mem__search_memory.execute({ query: "recent decisions" }),
    ).resolves.toBe("memory result");
    mocks.callMcpTool.mockResolvedValueOnce({ content: [] });
    mocks.mcpResultText.mockReturnValueOnce("");
    await expect(result.tools.mcp__dense_mem__search_memory.execute(undefined)).resolves.toBe(
      JSON.stringify({ content: [] }),
    );
    expect(mocks.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { query: "recent decisions" },
        tool: "search_memory",
      }),
    );
    expect(mocks.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: {},
        tool: "search_memory",
      }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "mcp.ai_tools.ready",
      expect.objectContaining({
        servers: "dense_mem",
        tools: "mcp__dense_mem__search_memory",
      }),
    );

    await result.close();
    expect(close).toHaveBeenCalled();
  });
});

describe("AI SDK optional MCP tools", () => {
  it("continues without tools when optional MCP model server setup fails", async () => {
    const logger = { event: vi.fn() };
    mocks.connectMcpServer.mockRejectedValue(new Error("offline"));

    await expect(
      createMcpAiTools({
        config: optionalMcpConfig(),
        logger,
        stage: "validate",
      }),
    ).resolves.toMatchObject({ tools: {} });
    expect(logger.event).toHaveBeenCalledWith("mcp.ai_tools.warning", {
      reason: "offline",
      server: "dense_mem",
    });
  });

  it("redacts optional MCP setup failures before logging warnings", async () => {
    const logger = { event: vi.fn() };
    vi.stubEnv("GITVIBE_MCP_ENV_JSON", JSON.stringify({ DENSE_MEM_TOKEN: "dense-token" }));
    mocks.connectMcpServer.mockRejectedValue(new Error("dense-token offline"));

    await expect(
      createMcpAiTools({
        config: optionalMcpBundleConfig(),
        logger,
        stage: "validate",
      }),
    ).resolves.toMatchObject({ tools: {} });
    expect(logger.event).toHaveBeenCalledWith("mcp.ai_tools.warning", {
      reason: "<redacted:mcp-secret> offline",
      server: "dense_mem",
    });
  });

  it("renders non-Error optional MCP setup failures as warnings", async () => {
    const logger = { event: vi.fn() };
    mocks.connectMcpServer.mockRejectedValue("offline");

    await expect(
      createMcpAiTools({
        config: optionalMcpConfig(),
        logger,
        stage: "validate",
      }),
    ).resolves.toMatchObject({ tools: {} });
    expect(logger.event).toHaveBeenCalledWith("mcp.ai_tools.warning", {
      reason: "offline",
      server: "dense_mem",
    });
  });

  it("warns without connecting when optional MCP credentials are missing", async () => {
    const logger = { event: vi.fn() };
    vi.stubEnv("GITVIBE_MCP_ENV_JSON", "{}");

    await expect(
      createMcpAiTools({
        config: optionalMcpBundleConfig(),
        logger,
        stage: "validate",
      }),
    ).resolves.toMatchObject({ tools: {} });
    expect(logger.event).toHaveBeenCalledWith("mcp.ai_tools.warning", {
      reason: expect.stringContaining("GITVIBE_MCP_ENV_JSON key DENSE_MEM_TOKEN is required"),
      server: "dense_mem",
    });
    expect(mocks.connectMcpServer).not.toHaveBeenCalled();
  });

  it("closes optional MCP connections when tool listing fails", async () => {
    const close = vi.fn();
    const logger = { event: vi.fn() };
    mocks.connectMcpServer.mockResolvedValue({
      client: { listTools: vi.fn().mockRejectedValue(new Error("list failed")) },
      close,
      server: { name: "dense_mem" },
    });

    await expect(
      createMcpAiTools({
        config: optionalMcpConfig(),
        logger,
        stage: "validate",
      }),
    ).resolves.toMatchObject({ tools: {} });
    expect(close).toHaveBeenCalled();
    expect(logger.event).toHaveBeenCalledWith("mcp.ai_tools.warning", {
      reason: "list failed",
      server: "dense_mem",
    });
  });
});

describe("AI SDK required MCP tool failures", () => {
  it("closes opened MCP connections when required setup fails", async () => {
    const close = vi.fn();
    mocks.connectMcpServer
      .mockResolvedValueOnce({
        client: { listTools: vi.fn().mockResolvedValue({ tools: [] }) },
        close,
        server: { name: "dense_mem" },
      })
      .mockRejectedValueOnce(new Error("docs offline"));

    await expect(
      createMcpAiTools({
        config: twoServerMcpConfig(),
        logger: { event: vi.fn() },
        stage: "validate",
      }),
    ).rejects.toThrow("docs offline");
    expect(close).toHaveBeenCalled();
  });

  it("rejects duplicate namespaced MCP tools", async () => {
    mocks.connectMcpServer.mockResolvedValue({
      client: {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { inputSchema: { type: "object" }, name: "search_memory" },
            { inputSchema: { type: "object" }, name: "search_memory" },
          ],
        }),
      },
      close: vi.fn(),
      server: { name: "dense_mem" },
    });

    await expect(
      createMcpAiTools({
        config: mcpConfig(),
        logger: { event: vi.fn() },
        stage: "validate",
      }),
    ).rejects.toThrow("Duplicate MCP tool name: mcp__dense_mem__search_memory.");
  });
});

function mcpConfig() {
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
        validate: {
          mcp: {
            dense_mem: {
              tools: ["search_memory"],
            },
          },
        },
      },
    },
  };
}

function optionalMcpConfig() {
  const config = mcpConfig();
  config.ai.stages.validate.mcp.dense_mem.required = false;
  return config;
}

function optionalMcpBundleConfig() {
  const config = optionalMcpConfig();
  config.ai.mcp.servers.dense_mem.env = {
    DENSE_MEM_TOKEN: { from_bundle: "DENSE_MEM_TOKEN" },
  };
  return config;
}

function twoServerMcpConfig() {
  const config = mcpConfig();
  config.ai.mcp.servers.docs = { command: "node" };
  config.ai.stages.validate.mcp.docs = {
    tools: ["lookup"],
  };
  return config;
}
