import type { GitVibeConfig, Stage } from "../shared/types.js";

export function activeProfileByName(
  config: GitVibeConfig,
  profileName: string,
): Record<string, unknown> {
  const ai = config.ai || {};
  const profiles = ai.profiles;
  if (!isRecord(profiles)) throw new Error("ai.profiles must be an object.");

  const profile = profiles[profileName];
  if (profile === undefined) throw new Error(`ai.profiles.${profileName} must be configured.`);
  if (!isRecord(profile)) throw new Error(`ai.profiles.${profileName} must be an object.`);

  return profile;
}

export function adapterName(profile: Record<string, unknown>, profilePath = "ai profile"): string {
  const adapter = stringValue(profile.adapter);
  if (!adapter) throw new Error(`${profilePath}.adapter must be configured.`);
  return adapter;
}

export function profileNamesForStage(config: GitVibeConfig, stage: Stage): string[] {
  const stageConfig = stageConfigFor(config, stage);
  if (stageConfig.profiles !== undefined) {
    throw new Error(
      `ai.stages.${stage}.profiles is no longer supported; use profile or role_group.`,
    );
  }
  if (stageConfig.fallback_profile !== undefined) {
    throw new Error(
      `ai.stages.${stage}.fallback_profile is no longer supported; use profile or role_group.`,
    );
  }
  if (stageConfig.role_group !== undefined) {
    throw new Error(`ai.stages.${stage}.role_group requires matrix workflow execution.`);
  }
  const profile = stringValue(stageConfig.profile);
  if (!profile) {
    throw new Error(`ai.stages.${stage} must define profile or role_group.`);
  }
  return [profile];
}

export function stageConfigFor(config: GitVibeConfig, stage: Stage): Record<string, unknown> {
  const stages = config.ai?.stages;
  if (stages === undefined) return {};
  if (!isRecord(stages)) throw new Error("ai.stages must be an object.");

  const stageConfig = stages[stage];
  if (stageConfig === undefined) return {};
  if (!isRecord(stageConfig)) throw new Error(`ai.stages.${stage} must be an object.`);

  return stageConfig;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
