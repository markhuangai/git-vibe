#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { runStage } from "../lib/stage-runner.js";
import { parseStage } from "../lib/stages.js";

const env = (name: string, fallback = ""): string => process.env[name] || fallback;
const stage = parseStage(process.argv[2]);
const dryRun = env("GITVIBE_DRY_RUN").toLowerCase() === "true";
const token = env("GITVIBE_GITHUB_TOKEN");
const repository = env("GITHUB_REPOSITORY");
const discussionNumber = env("GITVIBE_DISCUSSION_NUMBER");
const issueNumber = env("GITVIBE_ISSUE_NUMBER");
const prNumber = env("GITVIBE_PR_NUMBER");

if (!token) fail("GITVIBE_GITHUB_TOKEN is required.");
if (!repository) fail("GITHUB_REPOSITORY is required.");
validateTargetInputs();

runStage({
  configPath: env("GITVIBE_CONFIG_PATH", ".github/git-vibe.yml"),
  cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
  dryRun,
  issueNumber,
  maxTurns: numberEnv("GITVIBE_MAX_TURNS", 90),
  prNumber,
  repository,
  stage,
  stageTimeoutMinutes: numberEnv("GITVIBE_STAGE_TIMEOUT_MINUTES", 60),
  token,
})
  .then((result) => {
    log(`${stage} status=${result.status}`);
    log(result.summary);
    writeOutput("summary", result.summary);
    writeOutput("status", result.status);
    writeOutput("comment-body", result.commentBody);
  })
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });

function numberEnv(name: string, fallback: number): number {
  const rawValue = env(name);
  if (!rawValue) return fallback;

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number.`);
  return value;
}

function validateTargetInputs(): void {
  if (stage === "address-pr-feedback" && !prNumber) {
    fail("GITVIBE_PR_NUMBER is required for address-pr-feedback.");
  }
  if ((stage === "summarize" || stage === "materialize") && !discussionNumber) {
    fail("GITVIBE_DISCUSSION_NUMBER is required for this stage.");
  }
  if (stage === "validate" && !issueNumber && !discussionNumber) {
    fail("GITVIBE_ISSUE_NUMBER or GITVIBE_DISCUSSION_NUMBER is required for validate.");
  }
  if (
    !["address-pr-feedback", "summarize", "materialize", "validate"].includes(stage) &&
    !issueNumber
  ) {
    fail("GITVIBE_ISSUE_NUMBER is required for this stage.");
  }
}

function writeOutput(name: string, value: string): void {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<GITVIBE_OUTPUT\n${value}\nGITVIBE_OUTPUT\n`);
}

function log(message: string): void {
  console.log(`[git-vibe] ${message}`);
}

function fail(message: string): never {
  console.error(`[git-vibe] ${message}`);
  process.exit(1);
}
