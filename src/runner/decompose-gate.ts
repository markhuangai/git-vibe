import { applyStageLabelTransition, publishStageResultComment } from "./stage-publishing.js";
import { equivalentGitVibeLabelNames, gitVibeLabels } from "../shared/labels.js";
import type { GitHubClient } from "../shared/github.js";
import type { ContextPacket, JsonObject, RunnerOptions, StageRunResult } from "../shared/types.js";
import type { StageLogger } from "./logging.js";

export async function blockUnvalidatedDecompose(options: {
  buildResult: (content: string) => Promise<StageRunResult>;
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<StageRunResult | undefined> {
  if (options.runner.stage !== "decompose") return undefined;
  if (contextHasLabel(options.context, gitVibeLabels.validated.name)) return undefined;

  const result = await options.buildResult(
    JSON.stringify(unvalidatedDecomposeOutput(options.context)),
  );
  if (!options.runner.dryRun) {
    await publishStageResultComment({
      client: options.client,
      context: options.context,
      logger: options.logger,
      parsedOutput: result.parsedOutput,
      runner: options.runner,
      transientComments: [],
    });
    await applyStageLabelTransition({
      client: options.client,
      context: options.context,
      logger: options.logger,
      parsedOutput: result.parsedOutput,
      runner: options.runner,
      transientComments: [],
    });
  }
  options.logger.event("stage.done", { status: result.status });
  return result;
}

function unvalidatedDecomposeOutput(context: ContextPacket): JsonObject {
  const summary = "Decomposition is blocked because the discussion has not completed validation.";
  return {
    assumptions: [],
    comment_body: `${summary} Add ${gitVibeLabels.validate.name} and wait for ${gitVibeLabels.validated.name} before running ${gitVibeLabels.decompose.name}.`,
    findings: [summary],
    next_state: "blocked",
    references: [context.artifact.url].filter(Boolean),
    stage: "decompose",
    status: "blocked",
    story_units: [],
    summary,
  };
}

function contextHasLabel(context: ContextPacket, label: string): boolean {
  const names = new Set(equivalentGitVibeLabelNames(label));
  return (context.artifact.labels || []).some((name) => names.has(name));
}
