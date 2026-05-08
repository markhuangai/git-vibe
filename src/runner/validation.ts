import { execFileSync, spawnSync } from "node:child_process";
import type { GitVibeConfig, RunnerOptions } from "../shared/types.js";

export interface ValidationCommandFailure {
  command: string;
  exitCode?: number;
  signal?: string;
  stderr: string;
  stdout: string;
}

export class ValidationCommandError extends Error {
  readonly failure: ValidationCommandFailure;

  constructor(failure: ValidationCommandFailure) {
    super(`Command failed: ${failure.command}`);
    this.failure = failure;
  }
}

export function runValidationCommand(cwd: string, command: string): void {
  const result = spawnSync(command, {
    cwd,
    encoding: "utf8",
    shell: true,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  if (result.error || result.status !== 0) {
    throw new ValidationCommandError({
      command,
      exitCode: result.status === null ? undefined : result.status,
      signal: result.signal || undefined,
      stderr,
      stdout,
    });
  }
}

export function validationRepairAttemptsFor(config: GitVibeConfig, options: RunnerOptions): number {
  return positiveInteger(
    options.validationRepairAttempts,
    configNumber(config.tests, "validation_repair_attempts"),
    configNumber(config.ai?.budgets, "validation_repair_attempts"),
    3,
  );
}

export function validationRepairMaxTurnsFor(config: GitVibeConfig, options: RunnerOptions): number {
  return positiveInteger(
    options.validationRepairMaxTurns,
    configNumber(config.ai?.budgets, "validation_repair_max_turns"),
    45,
  );
}

export function buildValidationRepairPrompt(options: {
  attempt: number;
  basePrompt: string;
  cwd: string;
  failure: ValidationCommandFailure;
  maxAttempts: number;
  runner: RunnerOptions;
}): string {
  const failure = redactFailure(options.failure, secretValues(options.runner));
  return `${options.basePrompt}

<gitvibe_validation_repair>
GitVibe ran the configured validation commands after your implementation. The working tree was not committed because validation failed.

Repair attempt: ${options.attempt} of ${options.maxAttempts}
Failed command: ${failure.command}
Exit: ${failure.exitCode ?? failure.signal ?? "unknown"}

Git status:
\`\`\`
${gitOutput(options.cwd, ["status", "--short"]) || "(clean)"}
\`\`\`

Diff stat against HEAD:
\`\`\`
${gitOutput(options.cwd, ["diff", "--stat", "HEAD"]) || "(no diff)"}
\`\`\`

Stdout excerpt:
\`\`\`
${boundedText(failure.stdout) || "(empty)"}
\`\`\`

Stderr excerpt:
\`\`\`
${boundedText(failure.stderr) || "(empty)"}
\`\`\`

Fix the root cause in the current working tree. Preserve unrelated changes, keep the fix scoped, rerun the relevant checks when practical, and return JSON matching the same schema. Do not mark the stage completed unless the working tree is ready for GitVibe to validate again.
</gitvibe_validation_repair>`;
}

function positiveInteger(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return 1;
}

function configNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd }).toString().trim();
  } catch {
    return "";
  }
}

function boundedText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4000) return trimmed;
  return `${trimmed.slice(0, 1800)}

... output truncated ...

${trimmed.slice(-1800)}`;
}

function redactFailure(
  failure: ValidationCommandFailure,
  secrets: string[],
): ValidationCommandFailure {
  return {
    ...failure,
    stderr: redactText(failure.stderr, secrets),
    stdout: redactText(failure.stdout, secrets),
  };
}

function redactText(value: string, secrets: string[]): string {
  return secrets.reduce((text, secret) => text.split(secret).join("***"), value);
}

function secretValues(options: RunnerOptions): string[] {
  return [
    options.token,
    process.env.GITVIBE_AI_API_KEY,
    process.env.CODEX_AUTH_JSON,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ].filter((value): value is string => Boolean(value && value.length >= 4));
}
