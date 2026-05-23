import { summarizeError } from "./logging.js";

export function arrayField(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

export function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

export function toolStartFields(event: unknown): Record<string, unknown> {
  const name = toolName(event);
  return {
    call_id: toolCallId(event),
    step: toolStep(event),
    tool: name,
    ...toolInputSummary(name, toolInput(event)),
  };
}

export function toolFinishFields(event: unknown): Record<string, unknown> {
  const succeeded = toolCallSucceeded(event);
  return {
    call_id: toolCallId(event),
    duration_ms: numberField(event, "durationMs"),
    error: succeeded ? undefined : summarizeError(toolCallError(event)),
    step: toolStep(event),
    tool: toolName(event),
    ...toolOutputSummary(toolOutput(event)),
  };
}

export function toolNames(calls: unknown[]): string[] {
  return calls.map((call) => toolName(call)).filter((name) => name !== "<unknown>");
}

export function stringLength(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

export function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

export function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return recordValue(value?.[key]);
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolInputSummary(tool: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const value = input as Record<string, unknown>;

  if (tool === "read") return readInputSummary(value);
  if (tool === "glob") return pickFields(value, ["pattern", "path"]);
  if (tool === "grep") return grepInputSummary(value);
  if (tool === "bash") return pickFields(value, ["command", "description", "timeout"]);
  if (tool === "diff") return diffInputSummary(value);
  if (tool === "edit") return editInputSummary(value);
  if (tool === "write") return writeInputSummary(value);
  if (tool === "multi_edit") return multiEditInputSummary(value);
  if (tool === "github_search") return pickFields(value, ["query", "kind", "limit"]);
  if (tool === "web_fetch") return pickFields(value, ["url"]);
  if (tool === "web_search")
    return pickFields(value, ["query", "allowed_domains", "blocked_domains"]);
  if (tool === "output_validator") return outputValidatorInputSummary(value);

  return genericInputSummary(value);
}

function readInputSummary(input: Record<string, unknown>): Record<string, unknown> {
  return {
    file: stringField(input, "file_path") || stringField(input, "filePath"),
    limit: numberField(input, "limit"),
    offset: numberField(input, "offset"),
  };
}

function grepInputSummary(input: Record<string, unknown>): Record<string, unknown> {
  return pickFields(input, [
    "pattern",
    "path",
    "glob",
    "type",
    "output_mode",
    "context",
    "head_limit",
    "offset",
    "-A",
    "-B",
    "-C",
    "-i",
    "-n",
    "multiline",
  ]);
}

function diffInputSummary(input: Record<string, unknown>): Record<string, unknown> {
  return {
    file: stringField(input, "file_path"),
    new_chars: stringLength(input.new_content),
    old_chars: stringLength(input.old_content),
    other_file: stringField(input, "other_file_path"),
  };
}

function editInputSummary(input: Record<string, unknown>): Record<string, unknown> {
  return {
    file: stringField(input, "file_path"),
    new_chars: stringLength(input.new_string),
    old_chars: stringLength(input.old_string),
    replace_all: booleanField(input, "replace_all"),
  };
}

function writeInputSummary(input: Record<string, unknown>): Record<string, unknown> {
  return {
    content_chars: stringLength(input.content),
    file: stringField(input, "file_path"),
  };
}

function multiEditInputSummary(input: Record<string, unknown>): Record<string, unknown> {
  return {
    edits: arrayLength(input.edits),
    file: stringField(input, "file_path"),
  };
}

function outputValidatorInputSummary(input: Record<string, unknown>): Record<string, unknown> {
  const content = stringField(input, "content");
  const parsed = jsonObject(content);
  return {
    content_chars: stringLength(content),
    content_keys: parsed ? Object.keys(parsed).slice(0, 12).join(",") : undefined,
    stage: stringField(parsed, "stage"),
    status: stringField(parsed, "status"),
  };
}

function genericInputSummary(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .slice(0, 8)
      .map(([key, value]) => [key, fieldSummary(key, value)]),
  );
}

function toolOutputSummary(output: unknown): Record<string, unknown> {
  if (typeof output === "string") {
    return {
      result_chars: output.length,
      result_lines: output ? output.split("\n").length : 0,
    };
  }

  if (output && typeof output === "object") {
    return {
      result_keys: Object.keys(output as Record<string, unknown>)
        .slice(0, 12)
        .join(","),
    };
  }

  return {};
}

function toolCallError(event: unknown): unknown {
  if (!event || typeof event !== "object") return undefined;
  return (event as Record<string, unknown>).error;
}

function toolOutput(event: unknown): unknown {
  if (!event || typeof event !== "object") return undefined;
  return (event as Record<string, unknown>).output;
}

export function toolCallSucceeded(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  return (event as Record<string, unknown>).success === true;
}

function toolName(event: unknown): string {
  const name = toolCallName(toolCallRecord(event));
  if (name) return name;

  if (!event || typeof event !== "object") return "<unknown>";
  const eventRecord = event as Record<string, unknown>;
  const directName = eventRecord.toolName;
  if (typeof directName === "string") return directName;

  return "<unknown>";
}

function toolInput(event: unknown): unknown {
  const call = toolCallRecord(event);
  if (call && "input" in call) return call.input;
  if (!event || typeof event !== "object") return undefined;
  return (event as Record<string, unknown>).input;
}

function toolCallId(event: unknown): string | undefined {
  const call = toolCallRecord(event);
  return stringField(call, "toolCallId") || stringField(event, "toolCallId");
}

function toolStep(event: unknown): number | undefined {
  const stepNumber = numberField(event, "stepNumber");
  return stepNumber === undefined ? undefined : stepNumber + 1;
}

function toolCallRecord(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const nested = record.toolCall;
  return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : record;
}

function toolCallName(call: Record<string, unknown> | undefined): string | undefined {
  return stringField(call, "toolName");
}

function pickFields(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .map((key) => [key, fieldSummary(key, input[key])] as const)
      .filter(([, value]) => value !== undefined),
  );
}

function fieldSummary(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    return largeTextField(key) ? value.length : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 8).join(",");
  if (value && typeof value === "object") return Object.keys(value).slice(0, 8).join(",");
  return undefined;
}

function largeTextField(key: string): boolean {
  return key.includes("content") || key.endsWith("_string");
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
