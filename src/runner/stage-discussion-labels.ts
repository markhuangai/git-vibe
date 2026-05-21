import { addDiscussionLabel, removeDiscussionLabel } from "../shared/discussions.js";
import { gitVibeLabels } from "../shared/labels.js";
import type { GitHubClient } from "../shared/github.js";
import type { ContextPacket, JsonObject, RunnerOptions } from "../shared/types.js";
import type { StageLogger } from "./logging.js";

export interface DiscussionLabelTransitionOptions {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}

export async function applyDiscussionStageLabelTransition(
  options: DiscussionLabelTransitionOptions & { parsedOutput: JsonObject },
): Promise<void> {
  if (options.runner.stage === "validate") {
    const completed = String(options.parsedOutput.status || "completed") === "completed";
    const ready = isReadyForApproval(options.parsedOutput.next_state);
    await applyDiscussionLabels(options, {
      add: completed && ready ? [gitVibeLabels.validated.name] : [gitVibeLabels.blocked.name],
      remove: [
        gitVibeLabels.validating.name,
        completed && ready ? gitVibeLabels.blocked.name : gitVibeLabels.validated.name,
      ],
    });
    return;
  }
}

export async function applyDiscussionStageStartLabelTransition(
  options: DiscussionLabelTransitionOptions,
): Promise<void> {
  if (options.runner.stage === "validate") {
    await applyDiscussionLabels(options, {
      add: [gitVibeLabels.validating.name],
      remove: [gitVibeLabels.validated.name, gitVibeLabels.blocked.name],
    });
    return;
  }
}

async function applyDiscussionLabels(
  options: DiscussionLabelTransitionOptions,
  changes: { add: string[]; remove: string[] },
): Promise<void> {
  const discussionId = options.context.artifact.id;
  if (!discussionId) {
    options.logger.event("github.discussion.label.skip", {
      discussion: options.context.artifact.number,
      reason: "missing-discussion-id",
    });
    return;
  }

  for (const label of changes.remove) {
    await removeDiscussionLabelIfPresent({ ...options, discussionId, label });
  }
  for (const label of changes.add) {
    options.logger.event("github.discussion.label.start", {
      discussion: options.context.artifact.number,
      label,
    });
    await addDiscussionLabel({
      client: options.client,
      discussionId,
      label,
      repository: options.runner.repository,
      token: options.runner.token,
    });
    options.logger.event("github.discussion.label.done", {
      discussion: options.context.artifact.number,
      label,
    });
  }
}

async function removeDiscussionLabelIfPresent(options: {
  client: GitHubClient;
  discussionId: string;
  label: string;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  try {
    await removeDiscussionLabel({
      client: options.client,
      discussionId: options.discussionId,
      label: options.label,
      repository: options.runner.repository,
      token: options.runner.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    options.logger.event("github.discussion.label.remove.failed", {
      error: error instanceof Error ? error.message : String(error),
      label: options.label,
    });
    throw error;
  }
}

function isReadyForApproval(value: unknown): boolean {
  const state = String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
  return (
    state === "ready" ||
    state.endsWith(":ready") ||
    state === "ready-for-implementation" ||
    state.includes("ready-for-approval")
  );
}
