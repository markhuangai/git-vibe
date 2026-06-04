// @ts-nocheck
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientInstances: [],
  httpInstances: [],
  sseInstances: [],
  stdioInstances: [],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor(options) {
      this.close = vi.fn(async () => undefined);
      this.connect = vi.fn(async (transport) => {
        this.transport = transport;
      });
      this.options = options;
      mocks.clientInstances.push(this);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(options) {
      this.options = options;
      this.stderr = new EventEmitter();
      mocks.stdioInstances.push(this);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor(url, options) {
      this.options = options;
      this.url = url;
      mocks.sseInstances.push(this);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url, options) {
      this.options = options;
      this.url = url;
      mocks.httpInstances.push(this);
    }
  },
}));

const { connectMcpServer } = await import("../src/runner/mcp-client.ts");

beforeEach(() => {
  mocks.clientInstances.length = 0;
  mocks.httpInstances.length = 0;
  mocks.sseInstances.length = 0;
  mocks.stdioInstances.length = 0;
});

describe("MCP client transports", () => {
  it("connects stdio servers and pipes stderr through the stage logger", async () => {
    const logger = { event: vi.fn(), raw: vi.fn() };

    const connection = await connectMcpServer({
      logger,
      server: mcpServer({ args: ["server.js"], command: "node", transport: "stdio" }),
    });

    expect(mocks.stdioInstances[0].options).toMatchObject({
      args: ["server.js"],
      command: "node",
      stderr: "pipe",
    });
    mocks.stdioInstances[0].stderr.emit("data", Buffer.from("mcp warning"));
    mocks.stdioInstances[0].stderr.emit("data", "string warning");
    expect(logger.raw).toHaveBeenCalledWith("mcp warning");
    expect(logger.raw).toHaveBeenCalledWith("string warning");
    expect(logger.event).toHaveBeenCalledWith("mcp.connect.done", {
      server: "dense_mem",
      transport: "stdio",
    });
    await connection.close();
    expect(mocks.clientInstances[0].close).toHaveBeenCalled();

    const eventOnlyLogger = { event: vi.fn() };
    await connectMcpServer({
      logger: eventOnlyLogger,
      server: mcpServer({ command: "node", transport: "stdio" }),
    });
    mocks.stdioInstances[1].stderr.emit("data", "stderr without raw logger");
    expect(eventOnlyLogger.event).toHaveBeenCalledWith("mcp.connect.done", {
      server: "dense_mem",
      transport: "stdio",
    });
  });

  it("connects HTTP and SSE servers with configured request headers", async () => {
    await connectMcpServer({
      server: mcpServer({
        headers: { Authorization: "Bearer token" },
        transport: "http",
        url: "https://mcp.example.test/http",
      }),
    });
    await connectMcpServer({
      server: mcpServer({
        headers: { Authorization: "Bearer token" },
        transport: "sse",
        url: "https://mcp.example.test/sse",
      }),
    });

    expect(mocks.httpInstances[0].url.href).toBe("https://mcp.example.test/http");
    expect(mocks.httpInstances[0].options).toEqual({
      requestInit: { headers: { Authorization: "Bearer token" } },
    });
    expect(mocks.sseInstances[0].url.href).toBe("https://mcp.example.test/sse");
    expect(mocks.sseInstances[0].options).toEqual({
      requestInit: { headers: { Authorization: "Bearer token" } },
    });
  });

  it("connects URL transports without request headers", async () => {
    await connectMcpServer({
      server: mcpServer({
        transport: "http",
        url: "https://mcp.example.test/http",
      }),
    });
    await connectMcpServer({
      server: mcpServer({
        transport: "sse",
        url: "https://mcp.example.test/sse",
      }),
    });

    expect(mocks.httpInstances[0].options).toEqual({ requestInit: {} });
    expect(mocks.sseInstances[0].options).toEqual({ requestInit: {} });
  });

  it("rejects URL transports without a URL", async () => {
    await expect(
      connectMcpServer({
        server: mcpServer({ transport: "http", url: undefined }),
      }),
    ).rejects.toThrow("MCP server dense_mem requires a URL.");
  });
});

function mcpServer(overrides) {
  return {
    args: [],
    command: undefined,
    env: {},
    headers: {},
    name: "dense_mem",
    secretValues: [],
    transport: "stdio",
    ...overrides,
  };
}
