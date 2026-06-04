import { jsonSchema, type ToolSet } from "ai";
import type { RunAiStageOptions } from "./ai.js";
import { callMcpTool, connectMcpServer, mcpResultText } from "./mcp-client.js";
import { modelMcpServersForStage } from "./mcp-config.js";
import type { ConnectedMcpServer } from "./mcp-client.js";

export interface McpAiToolSet {
  close: () => Promise<void>;
  tools: ToolSet;
}

export async function createMcpAiTools(options: RunAiStageOptions): Promise<McpAiToolSet> {
  const stageServers = modelMcpServersForStage({
    config: options.config,
    stage: options.stage,
  });
  if (stageServers.length === 0) return emptyMcpAiTools();

  const connections: ConnectedMcpServer[] = [];
  const tools: ToolSet = {};
  try {
    for (const stageServer of stageServers) {
      let connection: ConnectedMcpServer | undefined;
      try {
        connection = await connectMcpServer({
          logger: options.logger,
          server: stageServer.server,
        });
        const listed = await connection.client.listTools();
        const activeConnection = connection;
        connections.push(activeConnection);
        for (const tool of listed.tools) {
          if (!stageServer.allowModelTools.includes(tool.name)) continue;
          const toolName = namespacedToolName(stageServer.server.name, tool.name);
          if (tools[toolName]) throw new Error(`Duplicate MCP tool name: ${toolName}.`);
          tools[toolName] = {
            description: [
              `Call MCP server ${stageServer.server.name} tool ${tool.name}.`,
              tool.description || "",
            ]
              .filter(Boolean)
              .join("\n"),
            execute: async (input: Record<string, unknown>) => {
              const result = await callMcpTool({
                arguments: input || {},
                connection: activeConnection,
                logger: options.logger,
                tool: tool.name,
              });
              const text = mcpResultText(result);
              return text || JSON.stringify(result);
            },
            inputSchema: jsonSchema(tool.inputSchema),
          } as ToolSet[string];
        }
      } catch (error) {
        if (connection && !connections.includes(connection)) await connection.close();
        if (stageServer.required) throw error;
        options.logger?.event("mcp.ai_tools.warning", {
          reason: error instanceof Error ? error.message : String(error),
          server: stageServer.server.name,
        });
      }
    }
  } catch (error) {
    await closeConnections(connections);
    throw error;
  }

  options.logger?.event("mcp.ai_tools.ready", {
    servers: stageServers.map((entry) => entry.server.name).join(","),
    tools: Object.keys(tools).join(","),
  });
  return {
    close: () => closeConnections(connections),
    tools,
  };
}

export function namespacedToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function emptyMcpAiTools(): McpAiToolSet {
  return { close: async () => undefined, tools: {} };
}

async function closeConnections(connections: ConnectedMcpServer[]): Promise<void> {
  await Promise.allSettled(connections.map((connection) => connection.close()));
}
