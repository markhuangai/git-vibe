#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runStage } from "../stage-runner.js";
import { parseSourceComment } from "../../shared/source-comments.js";
import { parseStage } from "../../shared/stages.js";
import type { StageRunResult } from "../../shared/types.js";

export interface ActionRuntime {
  appendFile?: (path: string, content: string) => void;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  error?: (message: string) => void;
  log?: (message: string) => void;
  runStage?: typeof runStage;
}

export async function runAction(runtime: ActionRuntime = {}): Promise<number> {
  const env = runtime.env || process.env;
  const argv = runtime.argv || process.argv.slice(2);
  const log = runtime.log || ((message) => console.log(`[git-vibe] ${message}`));
  const error = runtime.error || ((message) => console.error(`[git-vibe] ${message}`));

  try {
    const stage = parseStage(argv[0]);
    const token = requiredEnv(env, "GITVIBE_GITHUB_TOKEN");
    const repository = requiredEnv(env, "GITHUB_REPOSITORY");
    const target = readTargetInputs(stage, env);
    const result = await (runtime.runStage || runStage)({
      cwd: env.GITHUB_WORKSPACE || runtime.cwd || process.cwd(),
      dryRun: envValue(env, "GITVIBE_DRY_RUN").toLowerCase() === "true",
      issueNumber: target.issueNumber,
      maxTurns: numberEnv(env, "GITVIBE_MAX_TURNS", 90),
      prNumber: target.prNumber,
      repository,
      sourceComment: parseSourceComment(envValue(env, "GITVIBE_SOURCE_COMMENT")),
      stage,
      stageTimeoutMinutes: numberEnv(env, "GITVIBE_STAGE_TIMEOUT_MINUTES", 60),
      token,
      workflowRunUrl: workflowRunUrl(env),
    });

    log(`${stage} status=${result.status}`);
    log(result.summary);
    writeOutputs(env, result, runtime.appendFile || appendFileSync);
    return 0;
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    return 1;
  }
}

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!moduleUrl)
    return Boolean(entrypoint && /(?:^|[/\\])run-action\.(?:c?js|ts)$/.test(entrypoint));
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}

function readTargetInputs(
  stage: ReturnType<typeof parseStage>,
  env: NodeJS.ProcessEnv,
): { issueNumber: string; prNumber: string } {
  const discussionNumber = envValue(env, "GITVIBE_DISCUSSION_NUMBER");
  const issueNumber = envValue(env, "GITVIBE_ISSUE_NUMBER");
  const prNumber = envValue(env, "GITVIBE_PR_NUMBER");

  if (stage === "address-pr-feedback" && !prNumber) {
    throw new Error("GITVIBE_PR_NUMBER is required for address-pr-feedback.");
  }
  if ((stage === "summarize" || stage === "materialize") && !discussionNumber) {
    throw new Error("GITVIBE_DISCUSSION_NUMBER is required for this stage.");
  }
  if (stage === "validate" && !issueNumber && !discussionNumber) {
    throw new Error("GITVIBE_ISSUE_NUMBER or GITVIBE_DISCUSSION_NUMBER is required for validate.");
  }
  if (
    !["address-pr-feedback", "summarize", "materialize", "validate"].includes(stage) &&
    !issueNumber
  ) {
    throw new Error("GITVIBE_ISSUE_NUMBER is required for this stage.");
  }

  return { issueNumber, prNumber };
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const rawValue = envValue(env, name);
  if (!rawValue) return fallback;

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function workflowRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  const repository = envValue(env, "GITHUB_REPOSITORY");
  const runId = envValue(env, "GITHUB_RUN_ID");
  if (!repository || !runId) return undefined;
  const serverUrl = envValue(env, "GITHUB_SERVER_URL") || "https://github.com";
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function writeOutputs(
  env: NodeJS.ProcessEnv,
  result: StageRunResult,
  appendFile: (path: string, content: string) => void,
): void {
  if (!env.GITHUB_OUTPUT) return;
  writeOutput(env.GITHUB_OUTPUT, "summary", result.summary, appendFile);
  writeOutput(env.GITHUB_OUTPUT, "status", result.status, appendFile);
  writeOutput(env.GITHUB_OUTPUT, "comment-body", result.commentBody, appendFile);
}

function writeOutput(
  outputPath: string,
  name: string,
  value: string,
  appendFile: (path: string, content: string) => void,
): void {
  appendFile(outputPath, `${name}<<GITVIBE_OUTPUT\n${value}\nGITVIBE_OUTPUT\n`);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = envValue(env, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  return env[name] || "";
}

if (isDirectRun("", process.argv[1])) {
  runAction().then((code) => {
    process.exit(code);
  });
}
