import { compactMessages } from "agentool/context-compaction";
import type { LanguageModel, ModelMessage } from "ai";
import type { GitVibeConfig } from "../shared/types.js";
import type { StageLogger } from "./logging.js";

const defaultMaxContextWindowTokens = 200_000;
const compactionTriggerPct = 0.9;

interface ContextCompactionOptions {
  config: GitVibeConfig;
  logger?: StageLogger;
  model: LanguageModel;
  profile: Record<string, unknown>;
  profileName: string;
}

interface StepCompactionOptions extends ContextCompactionOptions {
  messages: ModelMessage[];
  stepNumber: number;
}

export function createContextCompactionPrepareStep(options: ContextCompactionOptions) {
  return async (event: { messages: ModelMessage[]; stepNumber: number }) =>
    compactStepMessages({ ...options, messages: event.messages, stepNumber: event.stepNumber });
}

export async function compactStepMessages(
  options: StepCompactionOptions,
): Promise<{ messages?: ModelMessage[] }> {
  const maxContextTokens = contextWindowTokensForProfile(
    options.profileName,
    options.profile,
    options.config,
  );
  const beforeTokens = estimateModelMessagesTokens(options.messages);
  const reason = compactionReason(beforeTokens, maxContextTokens);
  if (!reason) return {};

  const { baseMessages, incomingMessages } = compactionInput(reason, options.messages);
  try {
    const baseTokens = estimateModelMessagesTokens(baseMessages);
    const compactedBase = await compactMessages({
      autoCompactThresholdPct:
        reason === "pre_add"
          ? agentoolForceThresholdPct(baseTokens, maxContextTokens)
          : agentoolInclusiveThresholdPct(maxContextTokens),
      estimateTokens: estimateModelMessagesTokens,
      maxContextTokens,
      messages: baseMessages,
      onCompactionFailure: "throw",
      reservedOutputTokens: 0,
      summaryModel: options.model as never,
    });
    const compacted = [...compactedBase, ...incomingMessages];
    const compactedTokens = estimateModelMessagesTokens(compacted);
    const changed = compactedBase !== baseMessages;
    options.logger?.event("ai.context.compact", {
      after_tokens: compactedTokens,
      before_tokens: beforeTokens,
      changed,
      max_context_window_tokens: maxContextTokens,
      profile: options.profileName,
      reason,
      step: options.stepNumber + 1,
      threshold_pct: 90,
    });
    return changed ? { messages: compacted } : {};
  } catch (error) {
    options.logger?.event("ai.context.compact.failed", {
      before_tokens: beforeTokens,
      max_context_window_tokens: maxContextTokens,
      profile: options.profileName,
      reason,
      step: options.stepNumber + 1,
    });
    throw error;
  }
}

export function contextWindowTokensForProfile(
  profileName: string,
  profile: Record<string, unknown>,
  config: GitVibeConfig,
): number {
  const value = profile.context_window_tokens;
  if (value === undefined) return maxContextWindowTokensFor(config);
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Error(`AI profile ${profileName} context_window_tokens must be a positive integer.`);
}

export function maxContextWindowTokensFor(_config: GitVibeConfig): number {
  return defaultMaxContextWindowTokens;
}

export function estimateModelMessagesTokens(messages: ModelMessage[]): number {
  const chars = messages.reduce((total, message) => total + messageCharCount(message), 0);
  return Math.ceil(chars / 4);
}

function compactionReason(
  tokens: number,
  maxContextTokens: number,
): "pre_add" | "threshold" | undefined {
  if (tokens >= maxContextTokens) return "pre_add";
  return tokens >= compactionThresholdTokens(maxContextTokens) ? "threshold" : undefined;
}

function compactionThresholdTokens(maxContextTokens: number): number {
  return Math.ceil(maxContextTokens * compactionTriggerPct);
}

function agentoolInclusiveThresholdPct(maxContextTokens: number): number {
  const inclusiveThreshold = Math.max(1, compactionThresholdTokens(maxContextTokens) - 1);
  return inclusiveThreshold / maxContextTokens;
}

function agentoolForceThresholdPct(tokens: number, maxContextTokens: number): number {
  const thresholdTokens = Math.max(1, tokens - 1);
  return Math.min(1, thresholdTokens / maxContextTokens);
}

function nonSystemMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => message.role !== "system");
}

function compactionInput(
  reason: "pre_add" | "threshold",
  messages: ModelMessage[],
): { baseMessages: ModelMessage[]; incomingMessages: ModelMessage[] } {
  const nonSystem = nonSystemMessages(messages);
  if (reason !== "pre_add" || nonSystem.length <= 1) {
    return { baseMessages: nonSystem, incomingMessages: [] };
  }

  return {
    baseMessages: nonSystem.slice(0, -1),
    incomingMessages: nonSystem.slice(-1),
  };
}

function messageCharCount(message: ModelMessage): number {
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role.length : 0;
  return role + contentCharCount(record.content);
}

function contentCharCount(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + partCharCount(part), 0);
  }
  return safeJsonLength(content);
}

function partCharCount(part: unknown): number {
  if (!part || typeof part !== "object") return String(part ?? "").length;
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "text" || type === "reasoning") return stringLength(record.text);
  if (type === "image") return 1000;
  if (type === "file") return 200;
  if (type === "tool-call") return stringLength(record.toolName) + safeJsonLength(record.input);
  if (type === "tool-result") return stringLength(record.toolName) + safeJsonLength(record.output);
  return safeJsonLength(record);
}

function stringLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? "").length;
  } catch {
    return 50;
  }
}
