// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectMcpServer: vi.fn(),
  safetyCheckedMcpResult: vi.fn(({ result, secretValues }) =>
    redactResult(result, secretValues || []),
  ),
  serverInstances: [],
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    constructor() {
      this.handlers = [];
      this.connect = vi.fn(async () => undefined);
      mocks.serverInstances.push(this);
    }

    setRequestHandler(_schema, handler) {
      this.handlers.push(handler);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

vi.mock("../src/runner/mcp-client.js", () => ({
  connectMcpServer: mocks.connectMcpServer,
  mcpErrorResult: (message) => ({ content: [{ text: message, type: "text" }], isError: true }),
  redactMcpText: (value, secretValues) => redactText(value, secretValues),
  safetyCheckedMcpResult: mocks.safetyCheckedMcpResult,
}));

const { exitOnGatewayFailure, isDirectRun, runMcpGateway } =
  await import("../src/runner/actions/mcp-gateway.ts");

beforeEach(() => {
  mocks.connectMcpServer.mockReset();
  mocks.safetyCheckedMcpResult.mockClear();
  mocks.serverInstances.length = 0;
});

describe("MCP gateway runtime", () => {
  it("exposes only allowlisted tools and proxies allowed tool calls", async () => {
    const listTools = vi.fn().mockResolvedValue({
      tools: [{ name: "search_memory" }, { name: "write_memory" }],
    });
    const callTool = vi
      .fn()
      .mockResolvedValue({ content: [{ text: "dense-token result", type: "text" }] });
    mocks.connectMcpServer.mockResolvedValue({
      client: { callTool, listTools },
      close: vi.fn(),
      server: { name: "dense_mem" },
    });

    await expect(runMcpGateway(runtime())).resolves.toBe(0);

    const [listHandler, callHandler] = mocks.serverInstances[0].handlers;
    await expect(listHandler()).resolves.toEqual({ tools: [{ name: "search_memory" }] });
    await expect(
      callHandler({ params: { arguments: { query: "q" }, name: "search_memory" } }),
    ).resolves.toEqual({
      content: [{ text: "<redacted:mcp-secret> result", type: "text" }],
    });
    expect(callTool).toHaveBeenCalledWith({ arguments: { query: "q" }, name: "search_memory" });
    expect(mocks.safetyCheckedMcpResult).toHaveBeenCalledWith(
      expect.objectContaining({
        secretValues: ["dense-token"],
        server: "dense_mem",
        tool: "search_memory",
      }),
    );
  });

  it("rejects unallowlisted tools without connecting upstream", async () => {
    await expect(runMcpGateway(runtime())).resolves.toBe(0);

    const callHandler = mocks.serverInstances[0].handlers[1];
    await expect(callHandler({ params: { name: "write_memory" } })).resolves.toMatchObject({
      content: [{ text: "Error [mcp-gateway]: tool is not allowed: write_memory", type: "text" }],
      isError: true,
    });
    expect(mocks.connectMcpServer).not.toHaveBeenCalled();
  });

  it("redacts required server failures and hides optional list failures", async () => {
    mocks.connectMcpServer.mockRejectedValue(new Error("dense-token offline"));

    await expect(runMcpGateway(runtime())).resolves.toBe(0);
    await expect(mocks.serverInstances[0].handlers[0]()).rejects.toThrow(
      "MCP gateway dense_mem list tools failed: <redacted:mcp-secret> offline",
    );

    mocks.serverInstances.length = 0;
    await expect(runMcpGateway(runtime({ required: false }))).resolves.toBe(0);
    await expect(mocks.serverInstances[0].handlers[0]()).resolves.toEqual({ tools: [] });
  });

  it("redacts upstream call failures returned to the model", async () => {
    mocks.connectMcpServer.mockResolvedValue({
      client: {
        callTool: vi.fn().mockRejectedValue(new Error("dense-token offline")),
        listTools: vi.fn(),
      },
      close: vi.fn(),
      server: { name: "dense_mem" },
    });

    await expect(runMcpGateway(runtime())).resolves.toBe(0);

    const callHandler = mocks.serverInstances[0].handlers[1];
    await expect(callHandler({ params: { name: "search_memory" } })).resolves.toMatchObject({
      content: [
        {
          text: "Error [mcp-gateway]: dense_mem.search_memory failed: <redacted:mcp-secret> offline",
          type: "text",
        },
      ],
      isError: true,
    });
  });
});

describe("MCP gateway startup validation", () => {
  it("fails closed for missing or malformed gateway config", async () => {
    const stderr = vi.fn();

    await expect(runMcpGateway({ env: {}, stderr })).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("GITVIBE_MCP_GATEWAY_CONFIG is required.\n");

    stderr.mockClear();
    await expect(
      runMcpGateway({
        env: { GITVIBE_MCP_GATEWAY_CONFIG: "/config.json" },
        readFile: () => "[]",
        stderr,
      }),
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "GITVIBE_MCP_GATEWAY_CONFIG must point to a valid gateway config.\n",
    );

    stderr.mockClear();
    await expect(
      runMcpGateway({
        env: { GITVIBE_MCP_GATEWAY_CONFIG: "/config.json" },
        readFile: () => JSON.stringify({ allowTools: ["search_memory"], server: {} }),
        stderr,
      }),
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "GITVIBE_MCP_GATEWAY_CONFIG must point to a valid gateway config.\n",
    );

    for (const invalid of [
      null,
      { allowTools: "search_memory", required: true, server: { name: "dense_mem" } },
      { allowTools: ["search_memory"], required: "yes", server: { name: "dense_mem" } },
      { allowTools: ["search_memory"], required: true, server: {} },
    ]) {
      stderr.mockClear();
      await expect(
        runMcpGateway({
          env: { GITVIBE_MCP_GATEWAY_CONFIG: "/config.json" },
          readFile: () => JSON.stringify(invalid),
          stderr,
        }),
      ).resolves.toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        "GITVIBE_MCP_GATEWAY_CONFIG must point to a valid gateway config.\n",
      );
    }
  });

  it("detects direct CLI execution", () => {
    expect(isDirectRun("", "/tmp/mcp-gateway.js")).toBe(true);
    expect(isDirectRun("file:///tmp/mcp-gateway.js", "/tmp/mcp-gateway.js")).toBe(true);
    expect(isDirectRun("file:///tmp/other.js", "/tmp/mcp-gateway.js")).toBe(false);
  });

  it("keeps successful gateway processes alive and exits on startup failure", () => {
    const exit = vi.fn();

    exitOnGatewayFailure(0, exit);
    expect(exit).not.toHaveBeenCalled();

    exitOnGatewayFailure(1, exit);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

function runtime(overrides = {}) {
  return {
    env: { GITVIBE_MCP_GATEWAY_CONFIG: "/config.json" },
    readFile: () => JSON.stringify(gatewayConfig(overrides)),
    stderr: vi.fn(),
  };
}

function gatewayConfig(overrides = {}) {
  return {
    allowTools: ["search_memory"],
    required: true,
    server: {
      args: [],
      command: "node",
      env: {},
      headers: {},
      name: "dense_mem",
      secretValues: ["dense-token"],
      transport: "stdio",
    },
    ...overrides,
  };
}

function redactResult(result, secretValues) {
  return {
    ...result,
    content: result.content?.map((item) =>
      item.type === "text" ? { ...item, text: redactText(item.text, secretValues) } : item,
    ),
  };
}

function redactText(value, secretValues) {
  return secretValues.reduce(
    (text, secret) => text.split(secret).join("<redacted:mcp-secret>"),
    value,
  );
}
