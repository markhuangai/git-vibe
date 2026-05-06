import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { GitVibeConfig } from "../shared/types.js";

const gitVibeConfigPath = ".github/git-vibe.yml";

const configSchema = z
  .object({
    ai: z.record(z.string(), z.unknown()).optional(),
    branches: z
      .object({
        base: z.string().optional(),
      })
      .optional(),
    tests: z
      .object({
        commands: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

export function loadConfig(cwd = process.cwd()): GitVibeConfig {
  const absolutePath = resolve(cwd, gitVibeConfigPath);
  if (!existsSync(absolutePath)) {
    return {};
  }

  const parsed = parse(readFileSync(absolutePath, "utf8")) as unknown;
  return configSchema.parse(parsed || {}) as GitVibeConfig;
}

export function testCommandsFor(config: GitVibeConfig): string[] {
  return config.tests?.commands?.filter((command) => command.trim().length > 0) || [];
}
