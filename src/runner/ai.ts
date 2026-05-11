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
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
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
import { logAiSdkAssistantStep, logAiSdkIoInput, logAiSdkIoOutput } from "./ai-sdk-io.js";
import {
  extractValidatedOutput,
  outputValidatorContentFromSteps,
  type AiResult,
  type AiStep,
} from "./ai-output.js";
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
import { summarizeError } from "./logging.js";
import { validateOutput } from "./schemas.js";
import type { GitVibeConfig, JsonObject, Stage, StageDefinition } from "../shared/types.js";

export { retryDelayMsForHeaders };
export { extractValidatedOutput };

interface AiSdkRequest {
  activeTools?: string[];
  maxTurns: number;
  messages?: ModelMessage[];
  phase: string;
  prompt?: string;
  toolChoice?: unknown;
  tools: ToolSet;
}

interface AiSdkRuntime {
  contextWindowTokens: number | undefined;
  model: LanguageModel;
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
  state: {
    maxContextUsedPct?: number;
    stepCount: number;
  };
}

const OUTPUT_FINALIZATION_RESERVED_TURNS = 10;
const MIN_TURNS_BEFORE_RESERVE = OUTPUT_FINALIZATION_RESERVED_TURNS * 2;

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
  reserveFinalizationTurns?: boolean;
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
  const tools = createTools(options);
  const runtime = aiSdkRuntime({ options, profile, profileName });
  const primaryTurnBudget = primaryTurnBudgetFor(options);

  const primaryResult = await runAiSdkRequest(runtime, {
    maxTurns: primaryTurnBudget,
    phase: "primary",
    prompt: options.prompt,
    tools,
  });
  const primary = await validatedOutputOrError(primaryResult, options);
  if (primary.ok) {
    logAiSdkIoOutput({ options, output: primary.output, profileName, result: primaryResult });
    return primary.output;
  }

  const finalizationTurns = options.maxTurns - primaryTurnBudget;
  if (!options.reserveFinalizationTurns || finalizationTurns <= 0) throw primary.error;

  options.logger?.event("ai.continuation.start", {
    max_turns: finalizationTurns,
    reason: continuationReason(primaryResult, primaryTurnBudget),
  });
  const finalTools = { output_validator: tools.output_validator };
  const finalResult = await runAiSdkRequest(runtime, {
    activeTools: ["output_validator"],
    maxTurns: finalizationTurns,
    messages: continuationMessages({
      instruction: structuredOutputContinuationInstruction(primary.error),
      prompt: options.prompt,
      result: primaryResult,
    }),
    phase: "structured_output_continuation",
    toolChoice: { type: "tool", toolName: "output_validator" },
    tools: finalTools,
  });
  const final = await validatedOutputOrError(finalResult, options);
  if (!final.ok) throw final.error;
  logAiSdkIoOutput({ options, output: final.output, profileName, result: finalResult });
  return final.output;
}

function aiSdkRuntime(options: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
}): AiSdkRuntime {
  return {
    contextWindowTokens: contextWindowTokensForProfile(
      options.profileName,
      options.profile,
      options.options.config,
    ),
    model: createModel(options.options, options.profileName, options.profile),
    options: options.options,
    profile: options.profile,
    profileName: options.profileName,
    state: { stepCount: 0 },
  };
}

async function runAiSdkRequest(runtime: AiSdkRuntime, request: AiSdkRequest): Promise<AiResult> {
  runtime.options.logger?.event("ai.request.start", {
    context_window_tokens: runtime.contextWindowTokens,
    max_turns: runtime.options.maxTurns,
    model: modelName(runtime.profile),
    phase: request.phase,
    profile: runtime.profileName,
    provider: providerType(runtime.profile),
    turn_budget: request.maxTurns,
    tools: Object.keys(request.tools).join(","),
  });
  logAiSdkIoInput({
    model: modelName(runtime.profile),
    options: runtime.options,
    profileName: runtime.profileName,
    tools: request.tools,
  });
  const result = (await generateText({
    ...baseAiSdkRequest(runtime),
    ...aiSdkCallbacks(runtime),
    ...activeToolsInput(request),
    ...promptInput(request),
    stopWhen: [hasSchemaValidOutputValidatorCall(runtime.options), stepCountIs(request.maxTurns)],
    ...toolChoiceInput(request),
    tools: request.tools,
  })) as AiResult;
  runtime.options.logger?.event("ai.request.done", requestDoneFields(runtime, request, result));
  return result;
}

function baseAiSdkRequest(runtime: AiSdkRuntime) {
  return {
    maxRetries: 0,
    model: runtime.model,
    prepareStep: createContextCompactionPrepareStep({
      config: runtime.options.config,
      logger: runtime.options.logger,
      model: runtime.model,
      profile: runtime.profile,
      profileName: runtime.profileName,
    }),
    providerOptions: providerOptionsForRequest({
      options: runtime.options,
      profile: runtime.profile,
      profileName: runtime.profileName,
    }) as never,
    system: runtime.options.system,
    temperature: generationNumber(runtime.profile, "temperature", 0.2),
  };
}

function aiSdkCallbacks(runtime: AiSdkRuntime) {
  return {
    experimental_onToolCallFinish: (event: unknown) => {
      runtime.options.logger?.event(
        toolCallSucceeded(event) ? "ai.tool.done" : "ai.tool.failed",
        toolFinishFields(event),
      );
    },
    experimental_onToolCallStart: (event: unknown) => {
      runtime.options.logger?.event("ai.tool.start", toolStartFields(event));
    },
    onStepFinish: (event: unknown) => {
      runtime.state.stepCount += 1;
      const contextUsedPct = contextUsedPctForUsage(
        usageRecord(event),
        runtime.contextWindowTokens,
      );
      runtime.state.maxContextUsedPct = maxNumber(runtime.state.maxContextUsedPct, contextUsedPct);
      runtime.options.logger?.event("ai.step.done", stepDoneFields(runtime, event, contextUsedPct));
      logAiSdkAssistantStep({
        event,
        options: runtime.options,
        profileName: runtime.profileName,
        step: runtime.state.stepCount,
      });
    },
  };
}

function stepDoneFields(
  runtime: AiSdkRuntime,
  event: unknown,
  contextUsedPct: number | undefined,
): Record<string, unknown> {
  return {
    assistant_reasoning_chars: stringLength(stringField(event, "reasoningText")),
    assistant_text_chars: stringLength(stringField(event, "text")),
    finish_reason: stringField(event, "finishReason"),
    step: runtime.state.stepCount,
    tool_calls: arrayField(event, "toolCalls").length,
    tools: toolNames(arrayField(event, "toolCalls")).join(",") || "none",
    ...usageLogFields(usageRecord(event)),
    ...optionalNumberField("context_used_pct", contextUsedPct),
  };
}

function requestDoneFields(
  runtime: AiSdkRuntime,
  request: AiSdkRequest,
  result: AiResult,
): Record<string, unknown> {
  const toolCalls = result.steps?.flatMap((step) => step.toolCalls || []) || [];
  return {
    phase: request.phase,
    steps: result.steps?.length || runtime.state.stepCount,
    tool_calls: toolCalls.length,
    tools_used: toolNames(toolCalls).join(",") || "none",
    ...usageLogFields(requestUsageRecord(result)),
    ...optionalNumberField("max_context_used_pct", runtime.state.maxContextUsedPct),
  };
}

function activeToolsInput(request: AiSdkRequest): object {
  return request.activeTools ? { activeTools: request.activeTools as never } : {};
}

function promptInput(request: AiSdkRequest): { messages: ModelMessage[] } | { prompt: string } {
  return request.messages ? { messages: request.messages } : { prompt: request.prompt || "" };
}

function toolChoiceInput(request: AiSdkRequest): object {
  return request.toolChoice ? { toolChoice: request.toolChoice as never } : {};
}

function primaryTurnBudgetFor(options: RunAiStageOptions): number {
  if (!options.reserveFinalizationTurns || options.maxTurns <= MIN_TURNS_BEFORE_RESERVE) {
    return options.maxTurns;
  }
  return options.maxTurns - OUTPUT_FINALIZATION_RESERVED_TURNS;
}

async function validatedOutputOrError(
  result: AiResult,
  options: RunAiStageOptions,
): Promise<{ ok: true; output: string } | { error: unknown; ok: false }> {
  try {
    const output = outputValidatorContentFromSteps(result.steps || []);
    if (!output) throw new Error("AI response did not call output_validator");
    await validateOutput({ content: output, schema: options.schema, schemaId: options.schemaId });
    return { ok: true, output };
  } catch (error) {
    return { error, ok: false };
  }
}

function hasSchemaValidOutputValidatorCall(options: RunAiStageOptions) {
  return async ({ steps }: { steps: AiStep[] }): Promise<boolean> => {
    const content = outputValidatorContentFromSteps(steps);
    if (!content) return false;
    try {
      await validateOutput({ content, schema: options.schema, schemaId: options.schemaId });
      return true;
    } catch {
      return false;
    }
  };
}

function continuationReason(result: AiResult, primaryTurnBudget: number): string {
  return (result.steps?.length || 0) >= primaryTurnBudget
    ? "primary_turn_budget"
    : "structured_output_failure";
}

function continuationMessages(options: {
  instruction: string;
  prompt: string;
  result: AiResult;
}): ModelMessage[] {
  return [
    { content: options.prompt, role: "user" },
    ...responseMessages(options.result),
    { content: options.instruction, role: "user" },
  ];
}

function responseMessages(result: AiResult): ModelMessage[] {
  if (result.response?.messages?.length) return result.response.messages;
  return [{ content: result.text || "No final assistant text was returned.", role: "assistant" }];
}

function structuredOutputContinuationInstruction(error: unknown): string {
  return [
    "The primary stage turn budget is exhausted or the previous final output was not schema-valid.",
    "Stop repository work now. Summarize the completed work and return the required structured result.",
    "Call output_validator with the exact final JSON. If validation fails, fix every reported error and call output_validator again.",
    `Previous validation error: ${summarizeError(error)}`,
  ].join("\n");
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
