import type { ToolSet } from "ai";
import { stringField } from "./ai-tool-logging.js";
import type { RunAiStageOptions } from "./ai.js";
import type { StageLogger } from "./logging.js";
import { redactLogText } from "./logging.js";

export function logAiSdkIoInput(options: {
  model: string;
  options: RunAiStageOptions;
  profileName: string;
  tools: ToolSet;
}): void {
  options.options.logger?.raw?.(
    aiIoLogGroup({
      body: [
        fieldLine("adapter", "ai-sdk-agentool"),
        fieldLine("profile", options.profileName),
        fieldLine("model", options.model),
        fieldLine("schema_id", options.options.schemaId),
        fieldLine("max_turns", String(options.options.maxTurns)),
        fieldLine("tools", Object.keys(options.tools).join(",")),
        section("system", options.options.system),
        section("prompt", options.options.prompt),
      ].join("\n"),
      label: "input",
      logger: options.options.logger,
      options: options.options,
      profileName: options.profileName,
    }),
  );
}

export function logAiSdkIoOutput(options: {
  options: RunAiStageOptions;
  output: string;
  profileName: string;
  result: { text: string };
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
      logger: options.options.logger,
      options: options.options,
      profileName: options.profileName,
    }),
  );
}

export function logAiSdkAssistantStep(options: {
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
      logger: options.options.logger,
      options: options.options,
      profileName: options.profileName,
    }),
  );
}

function aiIoLogGroup(options: {
  body: string;
  label: "input" | "output";
  logger?: StageLogger;
  options: RunAiStageOptions;
  profileName: string;
}): string {
  return aiSdkLogGroup(options);
}

function aiSdkLogGroup(options: {
  body: string;
  label: "assistant" | "input" | "output";
  logger?: StageLogger;
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
