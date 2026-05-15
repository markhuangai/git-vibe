import { addDiscussionLabel, removeDiscussionLabel } from "../shared/discussions.js";
import { equivalentGitVibeLabelNames, gitVibeLabels } from "../shared/labels.js";
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

  if (options.runner.stage === "decompose") {
    const completed = String(options.parsedOutput.status || "completed") === "completed";
    await applyDiscussionLabels(options, {
      add: completed ? [gitVibeLabels.decomposed.name] : [gitVibeLabels.blocked.name],
      remove: [
        gitVibeLabels.decomposing.name,
        gitVibeLabels.decompose.name,
        completed ? gitVibeLabels.blocked.name : gitVibeLabels.decomposed.name,
      ],
    });
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

  if (options.runner.stage === "decompose") {
    await applyDiscussionLabels(options, {
      add: [gitVibeLabels.decomposing.name],
      remove: [
        gitVibeLabels.decomposed.name,
        gitVibeLabels.blocked.name,
        gitVibeLabels.decompose.name,
      ],
    });
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
    await removeEquivalentDiscussionLabels({ ...options, discussionId, label });
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

async function removeEquivalentDiscussionLabels(options: {
  client: GitHubClient;
  discussionId: string;
  label: string;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  for (const label of equivalentGitVibeLabelNames(options.label)) {
    try {
      await removeDiscussionLabel({
        client: options.client,
        discussionId: options.discussionId,
        label,
        repository: options.runner.repository,
        token: options.runner.token,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) continue;
      options.logger.event("github.discussion.label.remove.failed", {
        error: error instanceof Error ? error.message : String(error),
        label,
      });
      throw error;
    }
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
