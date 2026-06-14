import { GitHubClient } from "../shared/github.js";
import { createImplementationIssues } from "./materialize-issues.js";
import type { StageLogger } from "./logging.js";
import {
  applyStageLabelTransition,
  type PublishedArtifactComment,
  publishFeedbackInvestigationReplies,
  publishStageResultComment,
} from "./stage-publishing.js";
import type { ContextPacket, RunnerOptions, StageRunResult } from "../shared/types.js";

type DeterministicWriteOptions = {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  result: StageRunResult;
  transientComments: PublishedArtifactComment[];
};

export async function applyDeterministicWrites(
  options: DeterministicWriteOptions,
): Promise<StageRunResult> {
  if (options.options.dryRun) {
    options.logger.event("writes.skip", { reason: "dry-run" });
    return options.result;
  }

  if (options.result.status !== "completed") return publishBlockedResult(options);
  if (options.options.stage === "materialize") {
    await createImplementationIssues({ ...options, parsedOutput: options.result.parsedOutput });
    return options.result;
  }

  return publishReadOnlyResult(options);
}

async function publishBlockedResult(options: DeterministicWriteOptions): Promise<StageRunResult> {
  await publishStageResultComment({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  await applyStageLabelTransition({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  options.logger.event("writes.skip", { reason: "status", status: options.result.status });
  return options.result;
}

async function publishReadOnlyResult(options: DeterministicWriteOptions): Promise<StageRunResult> {
  if (options.options.stage === "investigate" && options.context.artifact.type === "pull-request") {
    await publishFeedbackInvestigationReplies({
      ...options,
      parsedOutput: options.result.parsedOutput,
      runner: options.options,
    });
  }
  await publishStageResultComment({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  await applyStageLabelTransition({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
  });
  return options.result;
}
