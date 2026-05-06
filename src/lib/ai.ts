import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { createBash } from "agentool/bash";
import { createDiff } from "agentool/diff";
import { createEdit } from "agentool/edit";
import { createGlob } from "agentool/glob";
import { createGrep } from "agentool/grep";
import { createMultiEdit } from "agentool/multi-edit";
import { createOutputValidator } from "agentool/output-validator";
import { createRead } from "agentool/read";
import { createWebFetch } from "agentool/web-fetch";
import { createWebSearch } from "agentool/web-search";
import { createWrite } from "agentool/write";
import type { LanguageModel, ToolSet } from "ai";
import type { StageLogger } from "./logging.js";
import { summarizeError } from "./logging.js";
import type { GitVibeConfig, JsonObject, StageDefinition } from "./types.js";

interface AiToolCall {
  input?: unknown;
  toolName?: string;
}

interface AiStep {
  toolCalls?: AiToolCall[];
}

interface AiResult {
  steps?: AiStep[];
  text: string;
}

export interface RunAiStageOptions {
  config: GitVibeConfig;
  cwd: string;
  maxTurns: number;
  prompt: string;
  schema: JsonObject;
  schemaId: string;
  stageDefinition: StageDefinition;
  system: string;
  logger?: StageLogger;
}

export async function runAiStage(options: RunAiStageOptions): Promise<string> {
  const logger = options.logger;
  const tools = createTools(options);
  let stepCount = 0;
  logger?.event("ai.request.start", {
    max_turns: options.maxTurns,
    model: modelName(options.config),
    profile: activeProfileName(options.config),
    provider: providerType(options.config),
    tools: Object.keys(tools).join(","),
  });

  const result = await generateText({
    experimental_onToolCallFinish: (event: unknown) => {
      logger?.event(toolCallSucceeded(event) ? "ai.tool.done" : "ai.tool.failed", {
        error: toolCallSucceeded(event) ? undefined : summarizeError(toolCallError(event)),
        tool: toolName(event),
      });
    },
    experimental_onToolCallStart: (event: unknown) => {
      logger?.event("ai.tool.start", { tool: toolName(event) });
    },
    maxRetries: 0,
    model: createModel(options.config),
    onStepFinish: (event: unknown) => {
      stepCount += 1;
      logger?.event("ai.step.done", {
        finish_reason: stringField(event, "finishReason"),
        step: stepCount,
        tool_calls: arrayField(event, "toolCalls").length,
      });
    },
    prompt: options.prompt,
    providerOptions: providerOptions(options.config) as never,
    stopWhen: stepCountIs(options.maxTurns),
    system: options.system,
    temperature: generationNumber(options.config, "temperature", 0.2),
    tools,
  });

  logger?.event("ai.request.done", {
    steps: result.steps?.length || stepCount,
    tool_calls: result.steps?.flatMap((step) => step.toolCalls || []).length || 0,
  });
  return extractValidatedOutput(result);
}

function createModel(config: GitVibeConfig): LanguageModel {
  const profile = activeProfile(config);
  const provider = profile.provider as Record<string, unknown> | undefined;
  const providerType = String(provider?.type || "openai-compatible");
  const model = envValue(provider?.model_variable, "GITVIBE_AI_MODEL");
  const apiKey = envValue(provider?.api_key_secret, "GITVIBE_AI_API_KEY");

  if (providerType === "anthropic") {
    return createAnthropic({ apiKey }).languageModel(model);
  }

  return createOpenAI({
    apiKey,
    baseURL:
      providerType === "openai"
        ? optionalEnvValue(provider?.base_url_variable, "GITVIBE_AI_BASE_URL")
        : envValue(provider?.base_url_variable, "GITVIBE_AI_BASE_URL"),
    name: "git-vibe-ai",
  }).chat(model);
}

function createTools(options: RunAiStageOptions): ToolSet {
  const cwd = options.cwd;
  const tools: ToolSet = {
    output_validator: createOutputValidator({
      schema: options.schema as never,
      schemaId: options.schemaId,
    }),
  };

  for (const toolName of options.stageDefinition.tools) {
    if (toolName === "read") tools.read = createRead({ cwd });
    if (toolName === "grep") tools.grep = createGrep({ cwd });
    if (toolName === "glob") tools.glob = createGlob({ cwd });
    if (toolName === "bash-readonly")
      tools.bash = createBash({ cwd, description: "Read-only shell commands only." });
    if (toolName === "bash") tools.bash = createBash({ cwd });
    if (toolName === "diff") tools.diff = createDiff({ cwd });
    if (toolName === "edit") tools.edit = createEdit({ cwd });
    if (toolName === "write") tools.write = createWrite({ cwd });
    if (toolName === "multi-edit") tools.multi_edit = createMultiEdit({ cwd });
    if (toolName === "web-fetch") tools.web_fetch = createWebFetch();
    if (toolName === "web-search") tools.web_search = createWebSearch();
  }

  return tools;
}

function activeProfile(config: GitVibeConfig): Record<string, unknown> {
  return activeProfileByName(config, activeProfileName(config));
}

function activeProfileByName(config: GitVibeConfig, profileName: string): Record<string, unknown> {
  const ai = config.ai || {};
  const profiles = (ai.profiles as Record<string, unknown> | undefined) || {};
  return (profiles[profileName] as Record<string, unknown> | undefined) || {};
}

function activeProfileName(config: GitVibeConfig): string {
  return String(config.ai?.default_profile || "local_proxy");
}

function modelName(config: GitVibeConfig): string {
  const provider = activeProfile(config).provider as Record<string, unknown> | undefined;
  return envValue(provider?.model_variable, "GITVIBE_AI_MODEL");
}

function providerType(config: GitVibeConfig): string {
  const provider = activeProfile(config).provider as Record<string, unknown> | undefined;
  return String(provider?.type || "openai-compatible");
}

function providerOptions(config: GitVibeConfig): Record<string, unknown> | undefined {
  const profile = activeProfile(config);
  return profile.provider_options as Record<string, unknown> | undefined;
}

function generationNumber(config: GitVibeConfig, key: string, fallback: number): number {
  const generation = activeProfile(config).generation as Record<string, unknown> | undefined;
  const value = generation?.[key];
  return typeof value === "number" ? value : fallback;
}

function envValue(variableName: unknown, fallbackName: string, fallbackValue?: string): string {
  const name = typeof variableName === "string" ? variableName : fallbackName;
  const value = process.env[name] || fallbackValue;
  if (!value) {
    throw new Error(`${name} is required for ai-sdk-agentool profile`);
  }
  return value;
}

function optionalEnvValue(variableName: unknown, fallbackName: string): string | undefined {
  const name = typeof variableName === "string" ? variableName : fallbackName;
  return process.env[name] || undefined;
}

export function extractValidatedOutput(result: AiResult): string {
  return outputValidatorContent(result) || extractJson(result.text);
}

function outputValidatorContent(result: AiResult): string | undefined {
  const calls = result.steps?.flatMap((step) => step.toolCalls || []) || [];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call.toolName !== "output_validator") continue;

    const input = call.input;
    if (!input || typeof input !== "object") continue;

    const content = (input as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content.trim();
    }
  }

  return undefined;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const match = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (match) {
    return match[1].trim();
  }

  throw new Error("AI response did not contain a JSON object");
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function toolCallError(event: unknown): unknown {
  if (!event || typeof event !== "object") return undefined;
  return (event as Record<string, unknown>).error;
}

function toolCallSucceeded(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  return (event as Record<string, unknown>).success === true;
}

function toolName(event: unknown): string {
  if (!event || typeof event !== "object") return "<unknown>";
  const eventRecord = event as Record<string, unknown>;
  const directName = eventRecord.toolName;
  if (typeof directName === "string") return directName;

  const toolCall = eventRecord.toolCall;
  if (!toolCall || typeof toolCall !== "object") return "<unknown>";
  const nestedName = (toolCall as Record<string, unknown>).toolName;
  return typeof nestedName === "string" ? nestedName : "<unknown>";
}
