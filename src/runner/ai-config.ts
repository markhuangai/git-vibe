import type { GitVibeConfig, Stage } from "../shared/types.js";

export function activeProfileByName(
  config: GitVibeConfig,
  profileName: string,
): Record<string, unknown> {
  const ai = config.ai || {};
  const profiles = (ai.profiles as Record<string, unknown> | undefined) || {};
  return (profiles[profileName] as Record<string, unknown> | undefined) || {};
}

export function adapterName(profile: Record<string, unknown>): string {
  return String(profile.adapter || "ai-sdk-agentool");
}

export function profileNamesForStage(config: GitVibeConfig, stage: Stage): string[] {
  const stageConfig = stageConfigFor(config, stage);
  const profileNames = explicitProfileNames(stageConfig) || [defaultProfileName(config)];
  const fallback = stringValue(stageConfig.fallback_profile);

  if (fallback && !profileNames.includes(fallback)) {
    return [...profileNames, fallback];
  }

  return profileNames;
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

function explicitProfileNames(stageConfig: Record<string, unknown>): string[] | undefined {
  const profile = stringValue(stageConfig.profile);
  if (profile && stageConfig.profiles !== undefined) {
    throw new Error("Stage AI config cannot define both profile and profiles.");
  }
  if (profile) return [profile];
  if (stageConfig.profiles === undefined) return undefined;
  if (!Array.isArray(stageConfig.profiles) || stageConfig.profiles.length === 0) {
    throw new Error("Stage AI config profiles must be a non-empty string array.");
  }

  const profiles = stageConfig.profiles.map((value) => stringValue(value));
  if (profiles.some((value) => !value)) {
    throw new Error("Stage AI config profiles must be a non-empty string array.");
  }

  return [...new Set(profiles as string[])];
}

function defaultProfileName(config: GitVibeConfig): string {
  return stringValue(config.ai?.default_profile) || "local_proxy";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
