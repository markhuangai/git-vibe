import { parseStage } from "../../shared/stages.js";
import type { RunnerOptions, Stage } from "../../shared/types.js";

export function acceptedRiskFromEnv(
  env: NodeJS.ProcessEnv,
): RunnerOptions["acceptedRisk"] | undefined {
  if (!isTrue(envValue(env, "GITVIBE_ACCEPT_RISK"))) return undefined;

  const stages = acceptedRiskStages(envValue(env, "GITVIBE_ACCEPT_RISK_STAGE"));
  if (stages.length === 0) {
    throw new Error("GITVIBE_ACCEPT_RISK_STAGE is required when GITVIBE_ACCEPT_RISK is true.");
  }
  const cutoff = envValue(env, "GITVIBE_ACCEPT_RISK_CUTOFF");
  if (!cutoff) {
    throw new Error("GITVIBE_ACCEPT_RISK_CUTOFF is required when GITVIBE_ACCEPT_RISK is true.");
  }
  if (!Number.isFinite(Date.parse(cutoff))) {
    throw new Error("GITVIBE_ACCEPT_RISK_CUTOFF must be an ISO timestamp.");
  }
  return {
    actor: envValue(env, "GITVIBE_ACCEPT_RISK_ACTOR") || undefined,
    artifactSha: envValue(env, "GITVIBE_ACCEPT_RISK_ARTIFACT_SHA") || undefined,
    cutoff,
    stages,
  };
}

function acceptedRiskStages(value: string): Stage[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseStage);
}

function isTrue(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  return env[name] || "";
}
