import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { join } from "node:path";
import type { RunAiStageOptions } from "./ai.js";
import { prepareCodexEnv, writeBackCodexAuth } from "./codex-auth.js";
import {
  cliModelName,
  commandParts,
  runStreamingCommand,
  strictOutputSchema,
  stringValue,
} from "./cli-adapter-utils.js";

export async function runCodexCliStage({
  options,
  profile,
  profileName,
}: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
}): Promise<string> {
  const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-codex-"));
  const schemaFile = join(contextDir, `${options.stage}.schema.json`);
  const outputFile = join(contextDir, `${options.stage}.output.json`);
  writeFileSync(schemaFile, JSON.stringify(strictOutputSchema(options.schema), null, 2));

  const [command, ...configuredArgs] = commandParts(profile, "codex exec");
  const model = cliModelName(profile, "cli-codex");
  const args = [
    ...configuredArgs,
    "--cd",
    options.cwd,
    "--model",
    model,
    "--output-schema",
    schemaFile,
    "--output-last-message",
    outputFile,
    ...codexReasoningArgs(profile),
  ];
  options.logger?.event("ai.request.start", {
    adapter: "cli-codex",
    model,
    profile: profileName,
    provider: "cli-codex",
  });

  const codexEnv = prepareCodexEnv({ contextDir, profile, profileName });
  await refreshCodexAuthBeforeRun({
    auth: codexEnv.auth,
    command,
    cwd: options.cwd,
    env: codexEnv.env,
    github: options.github,
    logger: options.logger,
  });
  const output = await runStreamingCommand({
    args,
    command,
    cwd: options.cwd,
    env: codexEnv.env,
    input: cliPrompt(options),
  });
  options.logger?.event("ai.request.done", {
    adapter: "cli-codex",
    stderr_chars: output.stderr.length,
    stdout_chars: output.stdout.length,
    profile: profileName,
  });
  await writeBackCodexAuth({
    auth: codexEnv.auth,
    github: options.github,
    logger: options.logger,
  });

  return readFileSync(outputFile, "utf8").trim();
}

function codexReasoningArgs(profile: Record<string, unknown>): string[] {
  const reasoning = profile.reasoning as Record<string, unknown> | undefined;
  const args: string[] = [];
  const effort = stringValue(reasoning?.effort);
  const summary = stringValue(reasoning?.summary);
  if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  if (summary) args.push("-c", `model_reasoning_summary=${JSON.stringify(summary)}`);
  return args;
}

async function refreshCodexAuthBeforeRun(options: {
  auth: ReturnType<typeof prepareCodexEnv>["auth"];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  github: RunAiStageOptions["github"];
  logger: RunAiStageOptions["logger"];
}): Promise<void> {
  if (!options.auth || !options.github || !isCodexCommand(options.command)) return;

  options.logger?.event("codex.auth_json.preflight.start", {});
  await runStreamingCommand({
    args: ["login", "status"],
    command: options.command,
    cwd: options.cwd,
    env: options.env,
    input: "",
  });
  await writeBackCodexAuth({
    auth: options.auth,
    github: options.github,
    logger: options.logger,
  });
  options.logger?.event("codex.auth_json.preflight.done", {});
}

function isCodexCommand(command: string): boolean {
  const name = basename(command).toLowerCase();
  return name === "codex" || name === "codex.exe";
}

function cliPrompt(options: RunAiStageOptions): string {
  return `${options.system}\n\n${options.prompt}`;
}
