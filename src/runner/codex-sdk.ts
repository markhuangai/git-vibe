import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadItem,
} from "@openai/codex-sdk";
import type { RunAiStageOptions } from "./ai.js";
import { logSdkWebPolicyNotice } from "./ai-web-policy.js";
import { codexOutputSchema, isRecord, sdkModelName, stringValue } from "./sdk-adapter-utils.js";
import { prepareCodexEnv, writeBackCodexAuth } from "./codex-auth.js";
import { summarizeError } from "./logging.js";
import { prepareSdkMcpConfig } from "./mcp-sdk-config.js";
import { validatedSdkOutput } from "./sdk-output.js";

export async function runCodexSdkStage({
  options,
  profile,
  profileName,
}: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
}): Promise<string> {
  const model = sdkModelName(profile, "codex-sdk");
  const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-codex-"));
  try {
    const mcpConfig = prepareSdkMcpConfig({ contextDir, options });
    const codexEnv = prepareCodexEnv({ contextDir, profile, profileName });
    const sdk = new Codex({
      config: codexConfig(profile, mcpConfig.codexConfig),
      env: stringEnv(codexEnv.env),
    });

    options.logger?.event("ai.request.start", {
      adapter: "codex-sdk",
      max_turns: options.maxTurns,
      model,
      profile: profileName,
      provider: "codex-sdk",
    });
    logSdkWebPolicyNotice({
      adapter: "codex-sdk",
      config: options.config,
      logger: options.logger,
    });

    const thread = sdk.startThread({
      approvalPolicy: "never",
      model,
      modelReasoningEffort: codexReasoningEffort(profile),
      sandboxMode: "danger-full-access",
      skipGitRepoCheck: true,
      workingDirectory: options.cwd,
    });
    const result = await thread.run(codexPrompt(options), {
      outputSchema: codexOutputSchema(options.schema),
    });
    for (const item of result.items) logCodexItem(item, options.logger);
    const validated = await validatedSdkOutput({
      content: result.finalResponse,
      schema: options.schema,
      schemaId: options.schemaId,
    });
    options.logger?.event("ai.request.done", {
      adapter: "codex-sdk",
      input_tokens: result.usage?.input_tokens,
      output_chars: validated.length,
      output_tokens: result.usage?.output_tokens,
      profile: profileName,
    });
    await writeBackCodexAuth({
      auth: codexEnv.auth,
      github: options.github,
      invalidAuth: "skip",
      logger: options.logger,
    });
    return validated;
  } finally {
    rmSync(contextDir, { force: true, recursive: true });
  }
}

function codexConfig(
  profile: Record<string, unknown>,
  mcpConfig: NonNullable<CodexOptions["config"]>,
): NonNullable<CodexOptions["config"]> {
  const reasoning = profile.reasoning as Record<string, unknown> | undefined;
  const summary = stringValue(reasoning?.summary);
  return {
    ...mcpConfig,
    ...(summary ? { model_reasoning_summary: summary } : {}),
  };
}

function codexReasoningEffort(profile: Record<string, unknown>): ModelReasoningEffort | undefined {
  const effort = stringValue((profile.reasoning as Record<string, unknown> | undefined)?.effort);
  if (!effort) return undefined;
  if (isCodexReasoningEffort(effort)) return effort;
  throw new Error(`AI profile reasoning.effort is not supported by codex-sdk: ${effort}.`);
}

function isCodexReasoningEffort(value: string): value is ModelReasoningEffort {
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function codexPrompt(options: RunAiStageOptions): string {
  return `${options.system}\n\n${options.prompt}`;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function logCodexItem(item: ThreadItem, logger: RunAiStageOptions["logger"]): void {
  if (item.type === "command_execution") {
    logger?.event("ai.codex.command", {
      command: summarizeError(item.command),
      exit_code: item.exit_code,
      status: item.status,
    });
    return;
  }
  if (item.type === "mcp_tool_call") {
    logger?.event("ai.codex.mcp_tool", {
      error: item.error?.message ? summarizeError(item.error.message) : undefined,
      server: item.server,
      status: item.status,
      tool: item.tool,
    });
    return;
  }
  if (item.type === "agent_message") {
    logger?.event("ai.codex.message", { text: summarizeError(item.text) });
    return;
  }
  if (item.type === "reasoning") {
    logger?.event("ai.codex.reasoning", { chars: item.text.length });
    return;
  }
  if (item.type === "file_change") {
    logger?.event("ai.codex.file_change", {
      changes: item.changes.length,
      status: item.status,
    });
    return;
  }
  if (item.type === "error") {
    logger?.event("ai.codex.error", { error: summarizeError(item.message) });
    return;
  }
  if (isRecord(item) && typeof item.type === "string") {
    logger?.event("ai.codex.item", { type: item.type });
  }
}
