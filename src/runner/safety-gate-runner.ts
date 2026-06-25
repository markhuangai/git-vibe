import { GitHubClient } from "../shared/github.js";
import type {
  ContextPacket,
  GitVibeConfig,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";
import type { ContentUnit } from "./content-units.js";
import type { StageLogger } from "./logging.js";
import {
  removeApprovalOnSafetyBlock,
  type SafetySource,
  safetyBlockedOutput,
} from "./safety-gate.js";
import { runAiSafetyGateForStage } from "./safety-ai-gate.js";
import type { RunAiStageOptions } from "./ai.js";
import { type PublishedArtifactComment, publishStageResultComment } from "./stage-publishing.js";
import { applySafetyBlockedLabelTransition } from "./stage-safety-labels.js";

export async function blockUnsafePromptInjection(options: {
  buildResult: (content: string) => Promise<StageRunResult>;
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  contextUnits?: ContentUnit[];
  extraSources?: SafetySource[];
  includeContext?: boolean;
  logger: StageLogger;
  phase: "input" | "output";
  result?: StageRunResult;
  runner: RunnerOptions;
  transientComments: PublishedArtifactComment[];
}): Promise<StageRunResult | undefined> {
  const result = await promptInjectionBlockedResult(options);
  if (!result) return undefined;
  if (options.runner.executionMode === "member") {
    options.logger.event("safety.gate.publish.skip", {
      phase: options.phase,
      reason: "matrix-member",
    });
    options.logger.event("stage.done", { status: result.status });
    return result;
  }
  await publishStageResultComment({
    client: options.client,
    context: options.context,
    logger: options.logger,
    parsedOutput: result.parsedOutput,
    runner: options.runner,
    transientComments: options.transientComments,
  });
  await applySafetyBlockedLabelTransition({
    client: options.client,
    context: options.context,
    logger: options.logger,
    preserveApproval: !removeApprovalOnSafetyBlock(options.config),
    runner: options.runner,
  });
  options.logger.event("stage.done", { status: result.status });
  return result;
}

export async function promptInjectionBlockedResult(options: {
  buildResult: (content: string) => Promise<StageRunResult>;
  client?: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  contextUnits?: ContentUnit[];
  extraSources?: SafetySource[];
  github?: RunAiStageOptions["github"];
  includeContext?: boolean;
  logger: StageLogger;
  phase: "input" | "output";
  result?: StageRunResult;
  runner: RunnerOptions;
}): Promise<StageRunResult | undefined> {
  if (options.runner.dryRun) return undefined;
  const gate = await runAiSafetyGateForStage({
    config: options.config,
    context: options.context,
    contextUnits: options.contextUnits,
    extraSources: options.extraSources,
    github:
      options.github ||
      (options.client
        ? {
            authWriteback: options.runner.githubAuthWriteback,
            client: options.client,
            repository: options.runner.repository,
            token: options.runner.token,
          }
        : undefined),
    includeContext: options.includeContext,
    logger: options.logger,
    output: options.result?.parsedOutput,
    phase: options.phase,
    runner: options.runner,
  });
  options.logger.event("safety.gate.checked", {
    allowed: gate.allowed,
    findings: gate.findings.length,
    phase: options.phase,
    severity: gate.severity,
  });
  if (gate.allowed) return undefined;

  const result = await options.buildResult(
    JSON.stringify(safetyBlockedOutput({ context: options.context, gate, runner: options.runner })),
  );
  options.logger.event("safety.gate.block", {
    findings: gate.findings.length,
    severity: gate.severity,
  });
  return result;
}
