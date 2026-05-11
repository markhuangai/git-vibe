import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { GitVibeConfig } from "./types.js";

const gitVibeConfigPath = ".github/git-vibe.yml";
export const gitVibeBaseBranchVariable = "GITVIBE_BASE_BRANCH";

const configSchema = z
  .object({
    ai: z.record(z.string(), z.unknown()).optional(),
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

  return parseConfig(readFileSync(absolutePath, "utf8"));
}

function parseConfig(content: string): GitVibeConfig {
  const parsed = parse(content) as unknown;
  return configSchema.parse(parsed || {}) as GitVibeConfig;
}

export function testCommandsFor(config: GitVibeConfig): string[] {
  return config.tests?.commands?.filter((command) => command.trim().length > 0) || [];
}
