#!/usr/bin/env node

import { appendFileSync, copyFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runStage } from "../stage-runner.js";
import { parseSourceComment } from "../../shared/source-comments.js";
import type { RunnerOptions, Stage, StageRunResult } from "../../shared/types.js";

export interface DevelopRuntime {
  appendFile?: (path: string, content: string) => void;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  error?: (message: string) => void;
  log?: (message: string) => void;
  runStage?: typeof runStage;
}

interface DevelopRunResult {
  resultFile?: string;
  reviewIterations: number;
  status: string;
  summary: string;
}

interface StageBudget {
  maxTurns: number;
  timeoutMinutes: number;
}

export async function runDevelop(runtime: DevelopRuntime = {}): Promise<number> {
  const env = runtime.env || process.env;
  const log = runtime.log || ((message) => console.log(`[git-vibe] ${message}`));
  const error = runtime.error || ((message) => console.error(`[git-vibe] ${message}`));

  try {
    const result = await runDevelopPipeline({ ...runtime, env, log });
    log(`develop status=${result.status}`);
    log(result.summary);
    writeOutputs(env, result, runtime.appendFile || appendFileSync);
    return result.status === "completed" ? 0 : 1;
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    return 1;
  }
}

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!moduleUrl)
    return Boolean(entrypoint && /(?:^|[/\\])run-develop\.(?:c?js|ts)$/.test(entrypoint));
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}

async function runDevelopPipeline(
  runtime: DevelopRuntime & {
    env: NodeJS.ProcessEnv;
    log: (message: string) => void;
  },
): Promise<DevelopRunResult> {
  const env = runtime.env;
  const cwd = env.GITHUB_WORKSPACE || runtime.cwd || process.cwd();
  const issueNumber = requiredEnv(env, "GITVIBE_ISSUE_NUMBER");
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  const token = requiredEnv(env, "GITVIBE_GITHUB_TOKEN");
  const run = runtime.runStage || runStage;
  const handoffDir = handoffDirectory(env, cwd);
  const maxReviewIterations = numberEnv(env, "GITVIBE_REVIEW_MAX_ITERATIONS", 5);
  let reviewIterations = 0;

  mkdirSync(handoffDir, { recursive: true });

  for (;;) {
    runtime.log(`develop.loop.implement iteration=${reviewIterations}`);
    const implement = await run(
      stageOptions(env, cwd, {
        handoffDir,
        issueNumber,
        repository,
        stage: "implement",
        token,
      }),
    );
    appendHandoff(handoffDir, implement);
    if (implement.status !== "completed") return developResult(implement, reviewIterations);

    runtime.log(`develop.loop.review iteration=${reviewIterations}`);
    const review = await run(
      stageOptions(env, cwd, {
        handoffDir,
        issueNumber,
        repository,
        stage: "review-matrix",
        token,
      }),
    );
    appendHandoff(handoffDir, review);

    const decision = reviewDecision(review);
    if (decision === "passed") {
      runtime.log(`develop.loop.create-pr iteration=${reviewIterations}`);
      const createPr = await run(
        stageOptions(env, cwd, {
          handoffDir,
          issueNumber,
          repository,
          stage: "create-pr",
          token,
        }),
      );
      appendHandoff(handoffDir, createPr);
      return developResult(createPr, reviewIterations);
    }

    if (decision === "blocked") return developResult(review, reviewIterations);
    if (reviewIterations >= maxReviewIterations) {
      throw new Error(
        `review-matrix requested changes after ${maxReviewIterations} review loop iteration(s).`,
      );
    }
    reviewIterations += 1;
  }
}

function stageOptions(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: {
    handoffDir: string;
    issueNumber: string;
    repository: string;
    stage: Stage;
    token: string;
  },
): RunnerOptions {
  const maxTurns = stageBudget(env, options.stage).maxTurns;
  return {
    cwd,
    dryRun: envValue(env, "GITVIBE_DRY_RUN").toLowerCase() === "true",
    handoffDir: options.handoffDir,
    issueNumber: options.issueNumber,
    maxTurns,
    prNumber: "",
    repository: options.repository,
    sourceComment: parseSourceComment(envValue(env, "GITVIBE_SOURCE_COMMENT")),
    stage: options.stage,
    stageTimeoutMinutes: stageBudget(env, options.stage).timeoutMinutes,
    token: options.token,
    validationRepairAttempts: numberEnv(env, "GITVIBE_VALIDATION_REPAIR_ATTEMPTS", 2),
    validationRepairMaxTurns: numberEnv(env, "GITVIBE_VALIDATION_REPAIR_MAX_TURNS", 90),
    workflowRunUrl: workflowRunUrl(env),
  };
}

function stageBudget(env: NodeJS.ProcessEnv, stage: Stage): StageBudget {
  if (stage === "implement") {
    return {
      maxTurns: numberEnv(env, "GITVIBE_IMPLEMENTATION_MAX_TURNS", 120),
      timeoutMinutes: numberEnv(env, "GITVIBE_IMPLEMENTATION_TIMEOUT_MINUTES", 120),
    };
  }
  if (stage === "create-pr") {
    return {
      maxTurns: numberEnv(env, "GITVIBE_PUBLISH_MAX_TURNS", 20),
      timeoutMinutes: numberEnv(env, "GITVIBE_PUBLISH_TIMEOUT_MINUTES", 15),
    };
  }
  return {
    maxTurns: numberEnv(env, "GITVIBE_MAX_TURNS", 90),
    timeoutMinutes: numberEnv(env, "GITVIBE_REVIEW_TIMEOUT_MINUTES", 60),
  };
}

function reviewDecision(result: StageRunResult): "blocked" | "changes-required" | "passed" {
  const nextState = normalized(result.parsedOutput.next_state);
  if (nextState.includes("review-passed")) return "passed";
  if (nextState.includes("changes-required") || nextState.includes("needs-changes")) {
    return "changes-required";
  }
  if (arrayField(result.parsedOutput.findings).length > 0) return "changes-required";
  if (result.status !== "completed") return "blocked";
  return "passed";
}

function appendHandoff(handoffDir: string, result: StageRunResult): void {
  if (!result.resultFile) return;
  const target = join(handoffDir, basename(result.resultFile));
  if (target === result.resultFile) return;
  mkdirSync(handoffDir, { recursive: true });
  copyFileSync(result.resultFile, target);
}

function developResult(result: StageRunResult, reviewIterations: number): DevelopRunResult {
  return {
    resultFile: result.resultFile,
    reviewIterations,
    status: result.status,
    summary: result.summary,
  };
}

function handoffDirectory(env: NodeJS.ProcessEnv, cwd: string): string {
  return envValue(env, "GITVIBE_HANDOFF_DIR") || join(env.RUNNER_TEMP || cwd, "git-vibe-handoffs");
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const rawValue = envValue(env, name);
  if (!rawValue) return fallback;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer.`);
  if (value === 0 && name !== "GITVIBE_REVIEW_MAX_ITERATIONS") {
    throw new Error(`${name} must be a positive integer.`);
  }
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
  result: DevelopRunResult,
  appendFile: (path: string, content: string) => void,
): void {
  if (!env.GITHUB_OUTPUT) return;
  writeOutput(env.GITHUB_OUTPUT, "summary", result.summary, appendFile);
  writeOutput(env.GITHUB_OUTPUT, "status", result.status, appendFile);
  writeOutput(env.GITHUB_OUTPUT, "review-iterations", String(result.reviewIterations), appendFile);
  if (result.resultFile)
    writeOutput(env.GITHUB_OUTPUT, "result-file", result.resultFile, appendFile);
}

function writeOutput(
  outputPath: string,
  name: string,
  value: string,
  appendFile: (path: string, content: string) => void,
): void {
  appendFile(outputPath, `${name}<<GITVIBE_OUTPUT\n${value}\nGITVIBE_OUTPUT\n`);
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalized(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
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
  runDevelop().then((code) => {
    process.exit(code);
  });
}
