import { addDiscussionLabel, removeDiscussionLabel } from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeLabels } from "../shared/labels.js";
import type { ContextPacket, RunnerOptions } from "../shared/types.js";
import type { StageLogger } from "./logging.js";

export interface SafetyBlockedLabelTransitionOptions {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  preserveApproval?: boolean;
  runner: RunnerOptions;
}

export async function applySafetyBlockedLabelTransition(
  options: SafetyBlockedLabelTransitionOptions,
): Promise<void> {
  if (options.context.artifact.type === "discussion") {
    await applyDiscussionSafetyBlockedLabels(options);
    return;
  }
  await applyIssueOrPullRequestSafetyBlockedLabels(options);
}

async function applyIssueOrPullRequestSafetyBlockedLabels(
  options: SafetyBlockedLabelTransitionOptions,
): Promise<void> {
  for (const label of issueSafetyBlockedStaleLabels(options)) {
    await removeIssueLabel({ ...options, label });
  }
  options.logger.event("github.issue.label.start", {
    issue: options.context.artifact.number,
    label: gitVibeLabels.blocked.name,
  });
  await addIssueLabel({ ...options, label: gitVibeLabels.blocked.name });
  options.logger.event("github.issue.label.done", {
    issue: options.context.artifact.number,
    label: gitVibeLabels.blocked.name,
  });
}

async function applyDiscussionSafetyBlockedLabels(
  options: SafetyBlockedLabelTransitionOptions,
): Promise<void> {
  const discussionId = options.context.artifact.id;
  if (!discussionId) {
    options.logger.event("github.discussion.label.skip", {
      discussion: options.context.artifact.number,
      reason: "missing-discussion-id",
    });
    return;
  }

  for (const label of discussionSafetyBlockedStaleLabels(options)) {
    await removeDiscussionLabelIfPresent({ ...options, discussionId, label });
  }
  options.logger.event("github.discussion.label.start", {
    discussion: options.context.artifact.number,
    label: gitVibeLabels.blocked.name,
  });
  await addDiscussionLabel({
    client: options.client,
    discussionId,
    label: gitVibeLabels.blocked.name,
    repository: options.runner.repository,
    token: options.runner.token,
  });
  options.logger.event("github.discussion.label.done", {
    discussion: options.context.artifact.number,
    label: gitVibeLabels.blocked.name,
  });
}

function issueSafetyBlockedStaleLabels(options: SafetyBlockedLabelTransitionOptions): string[] {
  const labels =
    options.context.artifact.type === "pull-request"
      ? [
          gitVibeLabels.investigating.name,
          gitVibeLabels.inProgress.name,
          gitVibeLabels.reviewing.name,
          gitVibeLabels.approved.name,
          gitVibeLabels.readyForApproval.name,
        ]
      : [
          gitVibeLabels.investigating.name,
          gitVibeLabels.inProgress.name,
          gitVibeLabels.approved.name,
          gitVibeLabels.readyForApproval.name,
        ];
  return maybePreserveApproval(labels, options.preserveApproval);
}

function discussionSafetyBlockedStaleLabels(
  options: SafetyBlockedLabelTransitionOptions,
): string[] {
  return maybePreserveApproval(
    [gitVibeLabels.validating.name, gitVibeLabels.validated.name, gitVibeLabels.approved.name],
    options.preserveApproval,
  );
}

function maybePreserveApproval(labels: string[], preserveApproval = false): string[] {
  return preserveApproval
    ? labels.filter((label) => label !== gitVibeLabels.approved.name)
    : labels;
}

async function addIssueLabel(
  options: SafetyBlockedLabelTransitionOptions & { label: string },
): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  await options.client.request({
    body: { labels: [options.label] },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/labels`,
    token: options.runner.token,
  });
}

async function removeIssueLabel(
  options: SafetyBlockedLabelTransitionOptions & { label: string },
): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  try {
    await options.client.request({
      method: "DELETE",
      path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/labels/${encodeURIComponent(options.label)}`,
      token: options.runner.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    options.logger.event("github.issue.label.remove.failed", {
      error: error instanceof Error ? error.message : String(error),
      issue: options.context.artifact.number,
      label: options.label,
    });
    throw error;
  }
}

async function removeDiscussionLabelIfPresent(
  options: SafetyBlockedLabelTransitionOptions & { discussionId: string; label: string },
): Promise<void> {
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
