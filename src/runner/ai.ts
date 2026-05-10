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
import {
  activeProfileByName,
  adapterName,
  profileNamesForStage,
  stageConfigFor,
  stringValue,
} from "./ai-config.js";
import {
  contextWindowTokensForProfile,
  createContextCompactionPrepareStep,
} from "./ai-compaction.js";
import { bundleValueFromSource } from "./cli-adapter-utils.js";
import { runClaudeCodeCliStage } from "./claude-code-cli.js";
import type { CodexAuthWritebackGitHub } from "./codex-auth.js";
import { runCodexCliStage } from "./codex-cli.js";
import { createRetryingFetch, retryDelayMsForHeaders } from "./ai-retry.js";
import {
  arrayField,
  numberField,
  recordField,
  recordValue,
  stringField,
  stringLength,
  toolCallSucceeded,
  toolFinishFields,
  toolNames,
  toolStartFields,
} from "./ai-tool-logging.js";
import type { StageLogger } from "./logging.js";
import { redactLogText, summarizeError } from "./logging.js";
import type { GitVibeConfig, JsonObject, Stage, StageDefinition } from "../shared/types.js";

export { retryDelayMsForHeaders };

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
  totalUsage?: unknown;
  usage?: unknown;
}

export interface RunAiStageOptions {
  config: GitVibeConfig;
  cwd: string;
  maxTurns: number;
  prompt: string;
  schema: JsonObject;
  schemaId: string;
  stage: Stage;
  stageDefinition: StageDefinition;
  system: string;
  github?: CodexAuthWritebackGitHub;
  toolOverride?: string[];
  logger?: StageLogger;
}

export async function runAiStage(options: RunAiStageOptions): Promise<string> {
  validateStageConfig(options);
  const profiles = profileNamesForStage(options.config, options.stage);
  let failure: unknown;

  for (const [index, profileName] of profiles.entries()) {
    if (index > 0) {
      options.logger?.event("ai.request.retry", {
        previous_error: summarizeError(failure),
        profile: profileName,
      });
    }

    try {
      return await runAiStageWithProfile(options, profileName);
    } catch (error) {
      failure = error;
      if (index === profiles.length - 1) throw error;
      options.logger?.event("ai.request.failed", {
        error: summarizeError(error),
        profile: profileName,
      });
    }
  }

  throw new Error(`No AI profile configured for ${options.stage}.`);
}

async function runAiStageWithProfile(
  options: RunAiStageOptions,
  profileName: string,
): Promise<string> {
  const profile = activeProfileByName(options.config, profileName);
  const adapter = adapterName(profile);
  if (adapter === "cli-codex") {
    return runCodexCliStage({
      options,
      profile,
      profileName,
    });
  }
  if (adapter === "cli-claude-code") {
    return runClaudeCodeCliStage({
      options,
      profile,
      profileName,
    });
  }
  if (adapter !== "ai-sdk-agentool") {
    throw new Error(`AI profile ${profileName} uses unsupported adapter ${adapter}.`);
  }

  return runAiSdkStageWithProfile(options, profileName, profile);
}

async function runAiSdkStageWithProfile(
  options: RunAiStageOptions,
  profileName: string,
  profile: Record<string, unknown>,
): Promise<string> {
  const logger = options.logger;
  const tools = createTools(options);
  const model = createModel(options, profileName, profile);
  const contextWindowTokens = contextWindowTokensForProfile(profileName, profile, options.config);
  let maxContextUsedPct: number | undefined;
  let stepCount = 0;
  logger?.event("ai.request.start", {
    context_window_tokens: contextWindowTokens,
    max_turns: options.maxTurns,
    model: modelName(profile),
    profile: profileName,
    provider: providerType(profile),
    tools: Object.keys(tools).join(","),
  });
  logAiSdkIoInput({ options, profile, profileName, tools });

  const result = await generateText({
    experimental_onToolCallFinish: (event: unknown) => {
      logger?.event(
        toolCallSucceeded(event) ? "ai.tool.done" : "ai.tool.failed",
        toolFinishFields(event),
      );
    },
    experimental_onToolCallStart: (event: unknown) => {
      logger?.event("ai.tool.start", toolStartFields(event));
    },
    maxRetries: 0,
    model,
    onStepFinish: (event: unknown) => {
      stepCount += 1;
      const contextUsedPct = contextUsedPctForUsage(usageRecord(event), contextWindowTokens);
      maxContextUsedPct = maxNumber(maxContextUsedPct, contextUsedPct);
      logger?.event("ai.step.done", {
        assistant_reasoning_chars: stringLength(stringField(event, "reasoningText")),
        assistant_text_chars: stringLength(stringField(event, "text")),
        finish_reason: stringField(event, "finishReason"),
        step: stepCount,
        tool_calls: arrayField(event, "toolCalls").length,
        tools: toolNames(arrayField(event, "toolCalls")).join(",") || "none",
        ...usageLogFields(usageRecord(event)),
        ...optionalNumberField("context_used_pct", contextUsedPct),
      });
      logAiSdkAssistantStep({ event, options, profileName, step: stepCount });
    },
    prepareStep: createContextCompactionPrepareStep({
      config: options.config,
      logger,
      model,
      profile,
      profileName,
    }),
    prompt: options.prompt,
    providerOptions: providerOptionsForRequest({ options, profile, profileName }) as never,
    stopWhen: stepCountIs(options.maxTurns),
    system: options.system,
    temperature: generationNumber(profile, "temperature", 0.2),
    tools,
  });

  logger?.event("ai.request.done", {
    steps: result.steps?.length || stepCount,
    tool_calls: result.steps?.flatMap((step) => step.toolCalls || []).length || 0,
    tools_used:
      toolNames(result.steps?.flatMap((step) => step.toolCalls || []) || []).join(",") || "none",
    ...usageLogFields(requestUsageRecord(result)),
    ...optionalNumberField("max_context_used_pct", maxContextUsedPct),
  });
  const output = extractValidatedOutput(result);
  logAiSdkIoOutput({ options, output, profileName, result });
  return output;
}

function usageLogFields(usage: Record<string, unknown> | undefined): Record<string, unknown> {
  const inputDetails = recordField(usage, "inputTokenDetails");
  const outputDetails = recordField(usage, "outputTokenDetails");
  const fields: Record<string, unknown> = {};

  addNumberField(fields, "input_tokens", numberField(usage, "inputTokens"));
  addNumberField(fields, "input_no_cache_tokens", numberField(inputDetails, "noCacheTokens"));
  addNumberField(
    fields,
    "input_cache_read_tokens",
    numberField(inputDetails, "cacheReadTokens") ?? numberField(usage, "cachedInputTokens"),
  );
  addNumberField(fields, "input_cache_write_tokens", numberField(inputDetails, "cacheWriteTokens"));
  addNumberField(fields, "output_tokens", numberField(usage, "outputTokens"));
  addNumberField(fields, "output_text_tokens", numberField(outputDetails, "textTokens"));
  addNumberField(
    fields,
    "output_reasoning_tokens",
    numberField(outputDetails, "reasoningTokens") ?? numberField(usage, "reasoningTokens"),
  );
  addNumberField(fields, "total_tokens", numberField(usage, "totalTokens"));

  return fields;
}

function requestUsageRecord(result: AiResult): Record<string, unknown> | undefined {
  return recordValue(result.totalUsage) || recordValue(result.usage);
}

function logAiSdkIoInput(options: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
  tools: ToolSet;
}): void {
  options.options.logger?.raw?.(
    aiIoLogGroup({
      body: [
        fieldLine("adapter", "ai-sdk-agentool"),
        fieldLine("profile", options.profileName),
        fieldLine("model", modelName(options.profile)),
        fieldLine("schema_id", options.options.schemaId),
        fieldLine("max_turns", String(options.options.maxTurns)),
        fieldLine("tools", Object.keys(options.tools).join(",")),
        section("system", options.options.system),
        section("prompt", options.options.prompt),
      ].join("\n"),
      label: "input",
      options: options.options,
      profileName: options.profileName,
    }),
  );
}

function logAiSdkIoOutput(options: {
  options: RunAiStageOptions;
  output: string;
  profileName: string;
  result: AiResult;
}): void {
  options.options.logger?.raw?.(
    aiIoLogGroup({
      body: [
        fieldLine("raw_text_chars", String(options.result.text.length)),
        fieldLine("extracted_json_chars", String(options.output.length)),
        section("raw_text", options.result.text),
        section("extracted_json", options.output),
      ].join("\n"),
      label: "output",
      options: options.options,
      profileName: options.profileName,
    }),
  );
}

function logAiSdkAssistantStep(options: {
  event: unknown;
  options: RunAiStageOptions;
  profileName: string;
  step: number;
}): void {
  const text = stringField(options.event, "text") || "";
  const reasoningText = stringField(options.event, "reasoningText") || "";
  if (!text && !reasoningText) return;

  options.options.logger?.raw?.(
    aiSdkLogGroup({
      body: [
        fieldLine("step", String(options.step)),
        fieldLine("assistant_text_chars", String(text.length)),
        fieldLine("assistant_reasoning_chars", String(reasoningText.length)),
        section("assistant_text", text),
        section("assistant_reasoning", reasoningText),
      ].join("\n"),
      label: "assistant",
      options: options.options,
      profileName: options.profileName,
    }),
  );
}

function aiIoLogGroup(options: {
  body: string;
  label: "input" | "output";
  options: RunAiStageOptions;
  profileName: string;
}): string {
  return aiSdkLogGroup(options);
}

function aiSdkLogGroup(options: {
  body: string;
  label: "assistant" | "input" | "output";
  options: RunAiStageOptions;
  profileName: string;
}): string {
  const title = `[git-vibe] ${options.options.stage} ai-sdk-agentool ${options.label} profile=${options.profileName} schema=${options.options.schemaId}`;
  return `::group::${title}\n${options.body}\n::endgroup::`;
}

function fieldLine(name: string, value: string): string {
  return `${name}: ${value}`;
}

function section(name: string, value: string): string {
  return `--- ${name} ---\n${boundedAiIoText(value)}`;
}

function boundedAiIoText(value: string): string {
  const redacted = redactLogText(value);
  if (redacted.length <= 200) return redacted;
  return `${redacted.slice(0, 200)}\n... git-vibe ai-sdk-agentool IO section truncated at 200 chars ...`;
}

function usageRecord(event: unknown): Record<string, unknown> | undefined {
  return recordField(recordValue(event), "usage");
}

function contextUsedPctForUsage(
  usage: Record<string, unknown> | undefined,
  contextWindowTokens: number | undefined,
): number | undefined {
  if (contextWindowTokens === undefined) return undefined;
  const inputTokens = numberField(usage, "inputTokens");
  if (inputTokens === undefined) return undefined;
  return Math.round((inputTokens / contextWindowTokens) * 1000) / 10;
}

function maxNumber(left: number | undefined, right: number | undefined): number | undefined {
  if (right === undefined) return left;
  if (left === undefined) return right;
  return Math.max(left, right);
}

function optionalNumberField(key: string, value: number | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function addNumberField(
  fields: Record<string, unknown>,
  key: string,
  value: number | undefined,
): void {
  if (value !== undefined) fields[key] = value;
}

function createModel(
  options: RunAiStageOptions,
  profileName: string,
  profile: Record<string, unknown>,
): LanguageModel {
  const provider = profile.provider as Record<string, unknown> | undefined;
  const providerType = String(provider?.type || "openai-compatible");
  const model = aiSdkModelName(profile);
  const profilePath = `ai.profiles.${profileName}.provider`;
  const apiKey = requiredProviderBundleValue(provider?.api_key, `${profilePath}.api_key`);
  const fetch = createRetryingFetch(options);

  if (providerType === "anthropic") {
    return createAnthropic({ apiKey, fetch }).languageModel(model);
  }

  return createOpenAI({
    apiKey,
    baseURL:
      providerType === "openai"
        ? optionalProviderBundleValue(provider?.base_url, `${profilePath}.base_url`)
        : requiredProviderBundleValue(provider?.base_url, `${profilePath}.base_url`),
    fetch,
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

  for (const toolName of toolsForStage(options)) {
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

function modelName(profile: Record<string, unknown>): string {
  return aiSdkModelName(profile);
}

function aiSdkModelName(profile: Record<string, unknown>): string {
  const provider = profile.provider as Record<string, unknown> | undefined;
  const model = stringValue(provider?.model);
  if (!model) throw new Error("AI SDK profile provider.model must be configured.");
  return model;
}

function providerType(profile: Record<string, unknown>): string {
  const provider = profile.provider as Record<string, unknown> | undefined;
  return String(provider?.type || "openai-compatible");
}

function providerOptionsForRequest(options: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
}): Record<string, unknown> | undefined {
  const base = cloneRecord(recordValue(options.profile.provider_options));
  const type = providerType(options.profile);
  if (type === "anthropic") {
    return withProviderDefaults({
      defaults: { cacheControl: { type: "ephemeral" } },
      profileName: options.profileName,
      provider: "anthropic",
      providerOptions: base,
    });
  }
  if (type === "openai") {
    return withProviderDefaults({
      defaults: { promptCacheKey: promptCacheKeyFor(options) },
      profileName: options.profileName,
      provider: "openai",
      providerOptions: base,
    });
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

function withProviderDefaults(options: {
  defaults: Record<string, unknown>;
  profileName: string;
  provider: string;
  providerOptions: Record<string, unknown>;
}): Record<string, unknown> {
  const current = providerNamespaceOptions({
    profileName: options.profileName,
    provider: options.provider,
    providerOptions: options.providerOptions,
  });
  options.providerOptions[options.provider] = { ...options.defaults, ...current };
  return options.providerOptions;
}

function providerNamespaceOptions(options: {
  profileName: string;
  provider: string;
  providerOptions: Record<string, unknown>;
}): Record<string, unknown> {
  const value = options.providerOptions[options.provider];
  if (value === undefined) return {};
  const current = recordValue(value);
  if (!current) {
    throw new Error(
      `ai.profiles.${options.profileName}.provider_options.${options.provider} must be an object.`,
    );
  }
  return cloneRecord(current);
}

function promptCacheKeyFor(options: { options: RunAiStageOptions; profileName: string }): string {
  return `git-vibe:${options.options.stage}:${options.options.schemaId}:${options.profileName}`;
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? { ...value } : {};
}

function generationNumber(profile: Record<string, unknown>, key: string, fallback: number): number {
  const generation = profile.generation as Record<string, unknown> | undefined;
  const value = generation?.[key];
  return typeof value === "number" ? value : fallback;
}

function toolsForStage(options: RunAiStageOptions): string[] {
  if (options.toolOverride) {
    const disallowed = options.toolOverride.filter((tool) => !toolAllowedForStage(tool, options));
    if (disallowed.length > 0) {
      throw new Error(
        `AI tool override for ${options.stage} includes disallowed tools: ${disallowed.join(", ")}.`,
      );
    }
    return options.toolOverride;
  }

  const configuredTools = stageConfigFor(options.config, options.stage).tools;
  if (configuredTools === undefined) return options.stageDefinition.tools;
  if (!Array.isArray(configuredTools) || configuredTools.some((tool) => !stringValue(tool))) {
    throw new Error(`ai.stages.${options.stage}.tools must be a string array.`);
  }

  const tools = configuredTools as string[];
  const disallowed = tools.filter((tool) => !options.stageDefinition.tools.includes(tool));
  if (disallowed.length > 0) {
    throw new Error(
      `ai.stages.${options.stage}.tools includes disallowed tools: ${disallowed.join(", ")}.`,
    );
  }

  return tools;
}

function toolAllowedForStage(tool: string, options: RunAiStageOptions): boolean {
  if (options.stageDefinition.tools.includes(tool)) return true;
  return tool === "bash-readonly" && options.stageDefinition.tools.includes("bash");
}

function validateStageConfig(options: RunAiStageOptions): void {
  const stageConfig = stageConfigFor(options.config, options.stage);
  if (stageConfig.enabled === false) {
    throw new Error(`ai.stages.${options.stage} is disabled.`);
  }
  if (stageConfig.enabled !== undefined && typeof stageConfig.enabled !== "boolean") {
    throw new Error(`ai.stages.${options.stage}.enabled must be a boolean.`);
  }

  const access = stringValue(stageConfig.access);
  if (stageConfig.access !== undefined && !access) {
    throw new Error(`ai.stages.${options.stage}.access must be a string.`);
  }
  if (access && access !== options.stageDefinition.access) {
    throw new Error(
      `ai.stages.${options.stage}.access must match canonical access ${options.stageDefinition.access}.`,
    );
  }
}

function requiredProviderBundleValue(source: unknown, sourcePath: string): string {
  if (source === undefined) {
    throw new Error(`${sourcePath}.from_bundle must be configured for ai-sdk-agentool profile.`);
  }
  const value = bundleValueFromSource(source, sourcePath);
  if (!value) throw new Error(`${sourcePath}.from_bundle resolved to an empty value.`);
  return value;
}

function optionalProviderBundleValue(source: unknown, sourcePath: string): string | undefined {
  if (source === undefined) return undefined;
  const value = bundleValueFromSource(source, sourcePath);
  return value || undefined;
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
