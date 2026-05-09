import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageDefinition } from "../shared/types.js";
import type { RunAiStageOptions } from "./ai.js";
import {
  bundleValueFromSource,
  cliProfileEnv,
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
    "--sandbox",
    codexSandbox(options.stageDefinition.access),
    ...codexReasoningArgs(profile),
  ];
  options.logger?.event("ai.request.start", {
    adapter: "cli-codex",
    model,
    profile: profileName,
    provider: "cli-codex",
  });

  const output = await runStreamingCommand({
    args,
    command,
    cwd: options.cwd,
    env: codexEnv(profile, profileName, contextDir),
    input: cliPrompt(options),
  });
  options.logger?.event("ai.request.done", {
    adapter: "cli-codex",
    stderr_chars: output.stderr.length,
    stdout_chars: output.stdout.length,
    profile: profileName,
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

function codexEnv(
  profile: Record<string, unknown>,
  profileName: string,
  contextDir: string,
): NodeJS.ProcessEnv {
  const env = cliProfileEnv(profile, `ai.profiles.${profileName}`);
  const authJson = bundleValueFromSource(profile.auth_json, `ai.profiles.${profileName}.auth_json`);
  if (authJson) {
    const codexHome = join(contextDir, "codex-home");
    env.CODEX_HOME = codexHome;
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), authJson);
  }
  return env;
}

function codexSandbox(access: StageDefinition["access"]): string {
  return access === "branch-write" ? "workspace-write" : "read-only";
}

function cliPrompt(options: RunAiStageOptions): string {
  return `${options.system}\n\n${options.prompt}`;
}
