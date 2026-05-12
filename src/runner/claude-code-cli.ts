import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAiStageOptions } from "./ai.js";
import {
  cliProfileEnv,
  cliModelName,
  isRecord,
  runStreamingCommand,
  strictOutputSchema,
  stringValue,
} from "./cli-adapter-utils.js";
import type { StageLogger } from "./logging.js";
import { redactLogText } from "./logging.js";

export async function runClaudeCodeCliStage({
  options,
  profile,
  profileName,
}: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
}): Promise<string> {
  const command = "claude";
  const model = cliModelName(profile, "cli-claude-code");
  const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-claude-"));
  const outputFile = join(contextDir, `${options.stage}.output.json`);
  const streamFile = join(contextDir, `${options.stage}.stream.jsonl`);
  const args = [
    "-p",
    ...claudeModeArgs(profile),
    "--dangerously-skip-permissions",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(strictOutputSchema(options.schema)),
    "--system-prompt",
    options.system,
    "--no-session-persistence",
    ...claudeReasoningArgs(profile),
  ];

  options.logger?.event("ai.request.start", {
    adapter: "cli-claude-code",
    model,
    profile: profileName,
    provider: "cli-claude-code",
  });
  logClaudePromptPreview(options.logger, options.stage, "system", options.system);
  logClaudePromptPreview(options.logger, options.stage, "user", options.prompt);

  const streamLogger = createClaudeStreamLogger(options.logger);
  const output = await runStreamingCommand({
    args,
    command,
    cwd: options.cwd,
    env: claudeEnv(profile, profileName),
    input: options.prompt,
    stdoutFile: streamFile,
    stdoutFlush: streamLogger.flush,
    stdoutLog: streamLogger.write,
  });
  const result = claudeOutput(readFileSync(streamFile, "utf8"));
  writeFileSync(outputFile, result);
  options.logger?.event("ai.request.done", {
    adapter: "cli-claude-code",
    output_file: outputFile,
    stderr_chars: output.stderr.length,
    stream_file: streamFile,
    stdout_chars: output.stdout.length,
    profile: profileName,
  });

  return readFileSync(outputFile, "utf8").trim();
}

function claudeReasoningArgs(profile: Record<string, unknown>): string[] {
  const reasoning = profile.reasoning as Record<string, unknown> | undefined;
  const effort = stringValue(reasoning?.effort);
  return effort ? ["--effort", effort] : [];
}

function claudeModeArgs(profile: Record<string, unknown>): string[] {
  return profile.bare === true ? ["--bare"] : [];
}

function claudeEnv(profile: Record<string, unknown>, profileName: string): NodeJS.ProcessEnv {
  return cliProfileEnv(profile, `ai.profiles.${profileName}`);
}

function createClaudeStreamLogger(logger: StageLogger | undefined): {
  flush: () => void;
  write: (text: string) => void;
} {
  let pending = "";
  return {
    flush() {
      if (pending.trim()) logClaudeStreamLine(pending, logger);
      pending = "";
    },
    write(text: string) {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) logClaudeStreamLine(line, logger);
    },
  };
}

function logClaudeStreamLine(line: string, logger: StageLogger | undefined): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const event = JSON.parse(trimmed) as unknown;
    if (isRecord(event)) {
      logClaudeEvent(event, logger);
      return;
    }
  } catch {
    // Fall through and log a compact raw line when Claude emits non-JSON output.
  }

  logClaudeProgress(logger, "ai.claude.raw", { text: compactText(trimmed) });
}

function logClaudeEvent(event: Record<string, unknown>, logger: StageLogger | undefined): void {
  const type = stringValue(event.type);
  if (type === "assistant") {
    logClaudeAssistantEvent(event, logger);
    return;
  }
  if (type === "result") {
    logClaudeResultEvent(event, logger);
    return;
  }
  if (type === "system") {
    logClaudeSystemEvent(event, logger);
    return;
  }
  if (type === "user") {
    logClaudeUserEvent(event, logger);
    return;
  }
  logClaudeProgress(logger, "ai.claude.event", { type: type || "unknown" });
}

function logClaudeAssistantEvent(
  event: Record<string, unknown>,
  logger: StageLogger | undefined,
): void {
  const content = messageContent(event);
  let emitted = false;
  for (const item of content) {
    const contentType = stringValue(item.type);
    if (contentType === "text") {
      logClaudeProgress(logger, "ai.claude.message", {
        text: compactText(stringValue(item.text) || ""),
      });
      emitted = true;
    }
    if (contentType === "thinking") {
      logClaudeProgress(logger, "ai.claude.thinking", {
        chars: String(item.thinking || "").length,
      });
      emitted = true;
    }
    if (contentType === "tool_use") {
      logClaudeProgress(logger, "ai.claude.tool", {
        input: summarizeToolInput(item.input),
        tool: stringValue(item.name) || "unknown",
      });
      emitted = true;
    }
  }
  if (!emitted) logClaudeProgress(logger, "ai.claude.assistant", { items: content.length });
}

function logClaudeSystemEvent(
  event: Record<string, unknown>,
  logger: StageLogger | undefined,
): void {
  const subtype = stringValue(event.subtype);
  if (subtype === "api_retry") {
    logClaudeProgress(logger, "ai.claude.retry", {
      attempt: event.attempt,
      delay_ms: Math.round(Number(event.retry_delay_ms) || 0),
      error: event.error,
      status: event.error_status,
    });
    return;
  }
  if (subtype === "init") {
    logClaudeProgress(logger, "ai.claude.init", {
      model: event.model,
      permission: event.permissionMode,
      tools: Array.isArray(event.tools) ? event.tools.length : undefined,
      version: event.claude_code_version,
    });
    return;
  }
  logClaudeProgress(logger, "ai.claude.system", { subtype: subtype || "unknown" });
}

function logClaudeUserEvent(event: Record<string, unknown>, logger: StageLogger | undefined): void {
  for (const item of messageContent(event)) {
    if (stringValue(item.type) !== "tool_result") continue;
    const content = String(item.content || "");
    logClaudeProgress(logger, "ai.claude.tool_result", {
      chars: content.length,
      error: item.is_error === true || undefined,
    });
  }
}

function logClaudeResultEvent(
  event: Record<string, unknown>,
  logger: StageLogger | undefined,
): void {
  logClaudeProgress(logger, "ai.claude.result", {
    duration_ms: event.duration_ms,
    error: event.is_error === true || undefined,
    reason: event.terminal_reason || event.stop_reason,
    subtype: event.subtype,
    turns: event.num_turns,
  });
}

function messageContent(event: Record<string, unknown>): Record<string, unknown>[] {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function summarizeToolInput(input: unknown): string {
  if (!isRecord(input)) return "";
  const filePath = stringValue(input.file_path);
  if (filePath) return `file_path=${filePath}`;
  const command = stringValue(input.command);
  if (command) return `command=${compactText(command)}`;
  const keys = Object.keys(input);
  return keys.length > 0 ? `keys=${keys.slice(0, 5).join(",")}` : "";
}

function logClaudeProgress(
  logger: StageLogger | undefined,
  name: string,
  fields: Record<string, unknown>,
): void {
  if (logger) {
    logger.event(name, fields);
    return;
  }

  const rendered = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${compactText(String(value))}`)
    .join(" ");
  process.stdout.write(redactLogText(`[git-vibe] ${name}${rendered ? ` ${rendered}` : ""}\n`));
}

function logClaudePromptPreview(
  logger: StageLogger | undefined,
  stage: string,
  kind: "system" | "user",
  text: string,
): void {
  const line = `[git-vibe] ${stage} ai.claude.prompt kind=${kind} preview=${JSON.stringify(
    previewText(text),
  )} chars=${text.length}`;
  if (logger?.raw) {
    logger.raw(line);
    return;
  }
  if (logger) {
    logger.event("ai.claude.prompt", { chars: text.length, kind, preview: previewText(text) });
    return;
  }
  process.stdout.write(redactLogText(`${line}\n`));
}

function previewText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 300 ? compact : `${compact.slice(0, 297)}...`;
}

function compactText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
}

function claudeOutput(stdout: string): string {
  const parsed = parseClaudeOutput(stdout);
  if (!isRecord(parsed)) throw new Error("Claude Code CLI returned a non-object result.");
  if (parsed.is_error === true || failedResultSubtype(parsed.subtype)) {
    throw new Error(`Claude Code CLI failed: ${claudeError(parsed)}`);
  }
  if (isRecord(parsed.structured_output)) {
    return JSON.stringify(parsed.structured_output);
  }
  return extractJson(String(parsed.result || ""));
}

function parseClaudeOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isClaudeStreamEvent(parsed)) return parseClaudeJsonLines(trimmed);
    return parsed;
  } catch {
    return parseClaudeJsonLines(trimmed);
  }
}

function isClaudeStreamEvent(event: unknown): boolean {
  return isRecord(event) && typeof event.type === "string" && event.type !== "result";
}

function parseClaudeJsonLines(stdout: string): unknown {
  let result: unknown;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as unknown;
    if (isRecord(event) && event.type === "result") result = event;
  }
  if (result !== undefined) return result;
  throw new Error("Claude Code CLI stream did not contain a result event.");
}

function failedResultSubtype(subtype: unknown): boolean {
  return typeof subtype === "string" && subtype.startsWith("error");
}

function claudeError(result: Record<string, unknown>): string {
  const errors = result.errors;
  if (Array.isArray(errors) && errors.length > 0) return errors.join("; ");
  if (typeof result.result === "string" && result.result) return result.result;
  return typeof result.subtype === "string" ? result.subtype : "unknown error";
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const match = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (match) return match[1].trim();

  throw new Error("Claude Code CLI result did not contain a JSON object.");
}
