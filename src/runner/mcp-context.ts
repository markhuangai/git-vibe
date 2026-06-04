import type { ContextPacket, GitVibeConfig, JsonObject, RunnerOptions } from "../shared/types.js";
import type { StageLogger } from "./logging.js";
import {
  connectMcpServer,
  callMcpTool,
  listMcpTools,
  mcpResultText,
  redactMcpText,
} from "./mcp-client.js";
import { renderMcpTemplateValue, stageMcpServers } from "./mcp-config.js";
import type { ConnectedMcpServer } from "./mcp-client.js";
import type { ResolvedStageMcpServer } from "./mcp-config.js";
import { mcpBlockedOutput } from "./stage-blocked-outputs.js";

export interface McpPromptContextResult {
  blocked?: JsonObject;
  promptAddition: string;
}

const maxMcpContextChars = 50_000;

export async function buildMcpPromptContext(options: {
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<McpPromptContextResult> {
  const servers = stageMcpServers({
    config: options.config,
    stage: options.runner.stage,
  }).filter((entry) => entry.contextCalls.length > 0 || entry.allowModelTools.length > 0);
  if (servers.length === 0) return { promptAddition: "" };

  const results: JsonObject[] = [];
  const warnings: string[] = [];
  for (const stageServer of servers) {
    if (!stageServer.server) {
      const reason = `MCP server ${stageServer.name} failed: ${stageServer.resolutionError}`;
      warnings.push(reason);
      options.logger.event("mcp.context.warning", { reason });
      continue;
    }
    try {
      const connection = await connectMcpServer({
        logger: options.logger,
        server: stageServer.server,
      });
      try {
        for (const call of stageServer.contextCalls) {
          const renderedArgs = renderMcpTemplateValue(
            call.arguments,
            options.context,
            options.runner,
          );
          const args = renderedArgs as JsonObject;
          const result = await callMcpTool({
            arguments: args,
            connection,
            logger: options.logger,
            tool: call.tool,
          });
          const text = redactMcpText(
            truncateContextText(mcpResultText(result)),
            stageServer.server.secretValues,
          );
          if (result.isError) {
            const reason = `MCP context call ${stageServer.name}.${call.tool} failed: ${text}`;
            const blocked = requiredFailure(stageServer.required, reason, options, warnings);
            if (blocked) return blocked;
            continue;
          }
          results.push({
            arguments: args,
            result_text: text,
            server: stageServer.name,
            tool: call.tool,
          });
        }
        if (stageServer.allowModelTools.length > 0) {
          await ensureModelToolsAvailable(connection, stageServer);
        }
      } finally {
        await connection.close();
      }
    } catch (error) {
      const reason = `MCP server ${stageServer.name} failed: ${redactMcpText(
        error instanceof Error ? error.message : String(error),
        stageServer.server.secretValues,
      )}`;
      const blocked = requiredFailure(stageServer.required, reason, options, warnings);
      if (blocked) return blocked;
    }
  }

  if (results.length === 0 && warnings.length === 0) return { promptAddition: "" };
  return {
    promptAddition: `<mcp_context>
${JSON.stringify(
  {
    results,
    warnings,
  },
  null,
  2,
)}
</mcp_context>`,
  };
}

async function ensureModelToolsAvailable(
  connection: ConnectedMcpServer,
  stageServer: ResolvedStageMcpServer,
): Promise<void> {
  const listed = await listMcpTools(connection);
  const available = new Set(listed.tools.map((tool) => tool.name));
  const missing = stageServer.allowModelTools.filter((tool) => !available.has(tool));
  if (missing.length > 0) {
    throw new Error(`missing allowed model tools on ${stageServer.name}: ${missing.join(", ")}`);
  }
}

function requiredFailure(
  required: boolean,
  reason: string,
  options: {
    context: ContextPacket;
    logger: StageLogger;
    runner: RunnerOptions;
  },
  warnings: string[],
): McpPromptContextResult | undefined {
  if (!required) {
    warnings.push(reason);
    options.logger.event("mcp.context.warning", { reason });
    return undefined;
  }
  options.logger.event("mcp.context.block", { reason });
  return {
    blocked: mcpBlockedOutput({
      context: options.context,
      reason,
      runner: options.runner,
    }),
    promptAddition: "",
  };
}

function truncateContextText(value: string): string {
  if (value.length <= maxMcpContextChars) return value;
  return `${value.slice(0, maxMcpContextChars)}\n[MCP result truncated to ${maxMcpContextChars} characters]`;
}
