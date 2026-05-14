#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import {
  stageExecutionPlan,
  stageWorkflowIndexes,
  stageWorkflowLabels,
  stageWorkflowMatrix,
} from "../role-groups.js";
import { parseStage } from "../../shared/stages.js";

export interface PlanStageRuntime {
  appendFile?: (path: string, content: string) => void;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  error?: (message: string) => void;
  log?: (message: string) => void;
}

export function planStage(runtime: PlanStageRuntime = {}): number {
  const env = runtime.env || process.env;
  const argv = runtime.argv || process.argv.slice(2);
  const log = runtime.log || ((message) => console.log(`[git-vibe] ${message}`));
  const error = runtime.error || ((message) => console.error(`[git-vibe] ${message}`));

  try {
    const stage = parseStage(argv[0]);
    const cwd = env.GITHUB_WORKSPACE || runtime.cwd || process.cwd();
    const plan = stageExecutionPlan(loadConfig(cwd), stage, cwd);
    log(`${stage} execution mode=${plan.mode} jobs=${plan.matrix.include.length}`);
    writeOutputs(env, plan, runtime.appendFile || appendFileSync);
    return 0;
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    return 1;
  }
}

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!moduleUrl)
    return Boolean(entrypoint && /(?:^|[/\\])plan-stage\.(?:c?js|ts)$/.test(entrypoint));
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}

function writeOutputs(
  env: NodeJS.ProcessEnv,
  plan: ReturnType<typeof stageExecutionPlan>,
  appendFile: (path: string, content: string) => void,
): void {
  if (!env.GITHUB_OUTPUT) return;
  writeOutput(env.GITHUB_OUTPUT, "matrix", JSON.stringify(stageWorkflowMatrix(plan)), appendFile);
  writeOutput(env.GITHUB_OUTPUT, "indexes", JSON.stringify(stageWorkflowIndexes(plan)), appendFile);
  writeOutput(env.GITHUB_OUTPUT, "labels", JSON.stringify(stageWorkflowLabels(plan)), appendFile);
  writeOutput(env.GITHUB_OUTPUT, "max-parallel", String(plan.maxParallel), appendFile);
  writeOutput(env.GITHUB_OUTPUT, "mode", plan.mode, appendFile);
}

function writeOutput(
  outputPath: string,
  name: string,
  value: string,
  appendFile: (path: string, content: string) => void,
): void {
  appendFile(outputPath, `${name}<<GITVIBE_OUTPUT\n${value}\nGITVIBE_OUTPUT\n`);
}

if (isDirectRun("", process.argv[1])) {
  process.exit(planStage());
}
