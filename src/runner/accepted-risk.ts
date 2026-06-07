import { addDiscussionComment, removeDiscussionLabel } from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeLabels } from "../shared/labels.js";
import { workflowRunIdFromUrl } from "../shared/status-comments.js";
import type { ContextPacket, RunnerOptions, StageRunResult } from "../shared/types.js";
import type { StageLogger } from "./logging.js";

export function acceptedRiskApplies(options: {
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): boolean {
  const accepted = options.runner.acceptedRisk;
  if (!accepted) return false;
  if (!accepted.stages.includes(options.runner.stage)) return false;
  if (options.context.artifact.type !== "pull-request" || !accepted.artifactSha) return true;

  const currentSha = options.context.artifact.pullRequestHead?.sha || "";
  if (currentSha && currentSha === accepted.artifactSha) return true;
  options.logger.event("accepted_risk.skip", {
    current_sha: currentSha,
    reason: "pull-request-head-changed",
  });
  return false;
}

export async function publishAcceptedRiskAudit(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  result?: StageRunResult;
  runner: RunnerOptions;
}): Promise<void> {
  if (options.runner.dryRun) {
    options.logger.event("accepted_risk.audit.skip", { reason: "dry-run" });
    return;
  }
  const body = acceptedRiskAuditBody(options);
  if (options.context.artifact.type === "discussion") {
    await publishDiscussionAudit(options, body);
  } else {
    await publishIssueAudit(options, body);
  }
  await removeAcceptedRiskLabel(options);
}

function acceptedRiskAuditBody(options: {
  context: ContextPacket;
  result?: StageRunResult;
  runner: RunnerOptions;
}): string {
  const actor = options.runner.acceptedRisk?.actor || "<unknown>";
  const run = workflowRunIdFromUrl(options.runner.workflowRunUrl);
  const runAttribute = run ? ` run=${run}` : "";
  const riskLine = options.result
    ? "The high-risk findings remain visible in the GitVibe blocked result above."
    : "The security scan did not detect high-risk prompt-injection content in this run.";
  return [
    `<!-- git-vibe:risk-accepted stage=${options.runner.stage} artifact=${options.context.artifact.type} number=${options.context.artifact.number}${runAttribute} -->`,
    "## GitVibe Risk Accepted",
    "",
    `${actorLabel(actor)} accepted prompt-injection input risk for one \`${options.runner.stage}\` run.`,
    riskLine,
    `GitVibe removed \`${gitVibeLabels.acceptRisk.name}\`; future runs require a fresh label.`,
    options.runner.workflowRunUrl ? `Workflow run: ${options.runner.workflowRunUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function publishDiscussionAudit(
  options: {
    client: GitHubClient;
    context: ContextPacket;
    logger: StageLogger;
    runner: RunnerOptions;
  },
  body: string,
): Promise<void> {
  const discussionId = options.context.artifact.id;
  if (!discussionId) {
    options.logger.event("accepted_risk.audit.skip", { reason: "missing-discussion-id" });
    return;
  }
  await addDiscussionComment({
    body,
    client: options.client,
    discussionId,
    token: options.runner.token,
  });
}

async function publishIssueAudit(
  options: { client: GitHubClient; context: ContextPacket; runner: RunnerOptions },
  body: string,
): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  await options.client.request({
    body: { body },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/comments`,
    token: options.runner.token,
  });
}

async function removeAcceptedRiskLabel(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  if (options.context.artifact.type === "discussion") {
    await removeDiscussionAcceptedRiskLabel(options);
    return;
  }
  await removeIssueAcceptedRiskLabel(options);
}

async function removeDiscussionAcceptedRiskLabel(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  const discussionId = options.context.artifact.id;
  if (!discussionId) {
    options.logger.event("accepted_risk.label.remove.skip", { reason: "missing-discussion-id" });
    return;
  }
  try {
    await removeDiscussionLabel({
      client: options.client,
      discussionId,
      label: gitVibeLabels.acceptRisk.name,
      repository: options.runner.repository,
      token: options.runner.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    throw error;
  }
}

async function removeIssueAcceptedRiskLabel(options: {
  client: GitHubClient;
  context: ContextPacket;
  runner: RunnerOptions;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  try {
    await options.client.request({
      method: "DELETE",
      path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/labels/${encodeURIComponent(gitVibeLabels.acceptRisk.name)}`,
      token: options.runner.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    throw error;
  }
}

function actorLabel(actor: string): string {
  return /^[A-Za-z0-9-]+$/u.test(actor) ? `@${actor}` : `\`${actor.replaceAll("`", "'")}\``;
}
