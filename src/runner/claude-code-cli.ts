import type { RunAiStageOptions } from "./ai.js";
import {
  cliProfileEnv,
  cliModelName,
  commandParts,
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
  const [command, ...configuredArgs] = commandParts(profile, "claude -p");
  const model = cliModelName(profile, "cli-claude-code");
  const args = [
    ...configuredArgs,
    ...claudeModeArgs(profile),
    "--model",
    model,
    "--output-format",
    "json",
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
  });
  options.logger?.event("ai.request.done", {
    adapter: "cli-claude-code",
    stderr_chars: output.stderr.length,
    stdout_chars: output.stdout.length,
    profile: profileName,
  });

  return claudeOutput(output.stdout);
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
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed)) throw new Error("Claude Code CLI returned a non-object result.");
  if (parsed.is_error === true) {
    throw new Error(`Claude Code CLI failed: ${claudeError(parsed)}`);
  }
  if (isRecord(parsed.structured_output)) {
    return JSON.stringify(parsed.structured_output);
  }
  return extractJson(String(parsed.result || ""));
}

function claudeError(result: Record<string, unknown>): string {
  const errors = result.errors;
  if (Array.isArray(errors) && errors.length > 0) return errors.join("; ");
  return typeof result.result === "string" && result.result ? result.result : "unknown error";
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const match = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (match) return match[1].trim();

  throw new Error("Claude Code CLI result did not contain a JSON object.");
}
