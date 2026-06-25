import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { GitVibeConfig } from "./types.js";

export const gitVibeConfigPath = ".github/git-vibe.yml";
export const gitVibeBaseBranchVariable = "GITVIBE_BASE_BRANCH";

const configSchema = z
  .object({
    ai: z.record(z.string(), z.unknown()).optional(),
    safety: z
      .object({
        block_write_stages_on_high_risk: z.boolean().optional(),
        ignored_authors: z.array(z.string()).optional(),
        prompt_injection_gate: z.boolean().optional(),
        remove_approval_on_block: z.boolean().optional(),
      })
      .optional(),
    tests: z
      .object({
        commands: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

export function baseBranchFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = env[gitVibeBaseBranchVariable]?.trim();
  return base || undefined;
}

export function loadConfig(cwd = process.cwd()): GitVibeConfig {
  const absolutePath = resolve(cwd, gitVibeConfigPath);
  if (!existsSync(absolutePath)) {
    return {};
  }

  return parseGitVibeConfig(readFileSync(absolutePath, "utf8"));
}

export function parseGitVibeConfig(content: string): GitVibeConfig {
  const parsed = parse(content) as unknown;
  return configSchema.parse(parsed || {}) as GitVibeConfig;
}

export function testCommandsFor(config: GitVibeConfig): string[] {
  return config.tests?.commands?.filter((command) => command.trim().length > 0) || [];
}

export function stageEnabled(config: GitVibeConfig, stage: string): boolean {
  const stages = config.ai?.stages;
  if (stages === undefined) return true;
  if (!isRecord(stages)) throw new Error("ai.stages must be an object.");

  const stageConfig = stages[stage];
  if (stageConfig === undefined) return true;
  if (!isRecord(stageConfig)) throw new Error(`ai.stages.${stage} must be an object.`);

  const enabled = stageConfig.enabled;
  if (enabled === undefined) return true;
  if (typeof enabled !== "boolean")
    throw new Error(`ai.stages.${stage}.enabled must be a boolean.`);
  return enabled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
