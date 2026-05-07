import { execFileSync } from "node:child_process";
import type { StageDefinition } from "../shared/types.js";
import type { RunAiStageOptions } from "./ai.js";
import {
  cliModelName,
  commandParts,
  isRecord,
  strictOutputSchema,
  stringValue,
} from "./cli-adapter-utils.js";

export function runClaudeCodeCliStage({
  options,
  profile,
  profileName,
  tools,
}: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
  tools: string[];
}): string {
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
    "--tools",
    claudeTools(tools),
    "--permission-mode",
    claudePermissionMode(options.stageDefinition.access),
    "--no-session-persistence",
    ...claudeReasoningArgs(profile),
  ];

  options.logger?.event("ai.request.start", {
    adapter: "cli-claude-code",
    max_turns: options.maxTurns,
    model,
    profile: profileName,
    provider: "cli-claude-code",
    tools: tools.join(","),
  });

  const output = execFileSync(command, args, {
    cwd: options.cwd,
    env: claudeEnv(profile),
    input: options.prompt,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = output.toString("utf8");
  options.logger?.event("ai.request.done", {
    adapter: "cli-claude-code",
    output_chars: stdout.length,
    profile: profileName,
  });

  return claudeOutput(stdout);
}

function claudeReasoningArgs(profile: Record<string, unknown>): string[] {
  const reasoning = profile.reasoning as Record<string, unknown> | undefined;
  const effort = stringValue(reasoning?.effort);
  return effort ? ["--effort", effort] : [];
}

function claudeModeArgs(profile: Record<string, unknown>): string[] {
  return profile.bare === true ? ["--bare"] : [];
}

function claudeEnv(profile: Record<string, unknown>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const tokenSecret = stringValue(profile.oauth_token_secret);
  const token = tokenSecret ? process.env[tokenSecret] : undefined;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

function claudePermissionMode(access: StageDefinition["access"]): string {
  return access === "branch-write" ? "acceptEdits" : "dontAsk";
}

function claudeTools(tools: string[]): string {
  const allowed = tools.flatMap((tool) => claudeToolNames[tool] || []);
  return [...new Set(allowed)].join(",");
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

const claudeToolNames: Record<string, string[]> = {
  "bash-readonly": ["Bash"],
  bash: ["Bash"],
  edit: ["Edit"],
  glob: ["Glob"],
  grep: ["Grep"],
  "multi-edit": ["MultiEdit"],
  read: ["Read"],
  "web-fetch": ["WebFetch"],
  "web-search": ["WebSearch"],
  write: ["Write"],
};
