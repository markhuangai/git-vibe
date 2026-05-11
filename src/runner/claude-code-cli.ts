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

  const output = await runStreamingCommand({
    args,
    command,
    cwd: options.cwd,
    env: claudeEnv(profile, profileName),
    input: options.prompt,
    stdoutFile: streamFile,
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
