import { reviewWorkflowBudgetInputs } from "../shared/budgets.js";
import { gitVibeConfigPath, stageEnabled } from "../shared/config.js";
import { gitVibeInternalLabels, gitVibeLabels } from "../shared/labels.js";
import {
  addIssueLabel,
  createIssueComment,
  dispatchWorkflow,
  labelReason,
  postQueuedWorkflowComment,
  removeIssueLabelIfPresent,
  repositoryGitVibeConfig,
  type WebhookActionContext,
} from "./server-actions.js";
import { removeIssueLabel } from "./labels.js";

export async function handleReviewPullRequestLabel(
  options: WebhookActionContext,
  issueNumber: string,
  label: string,
): Promise<void> {
  if (!options.payload.issue?.pull_request) {
    await removeReviewLabel(options, issueNumber, label);
    await createIssueComment(options, issueNumber, reviewLabelRequiresPullRequestBody(label));
    return;
  }

  let config = {};
  let reviewEnabled = true;
  try {
    config = await repositoryGitVibeConfig(options);
    reviewEnabled = stageEnabled(config, "review-matrix");
  } catch (error) {
    await removeReviewLabel(options, issueNumber, label);
    await createIssueComment(options, issueNumber, reviewConfigErrorBody(label, error));
    return;
  }
  if (!reviewEnabled) {
    await removeReviewLabel(options, issueNumber, label);
    await createIssueComment(options, issueNumber, reviewDisabledBody(label));
    return;
  }

  const dispatch = await dispatchWorkflow(options, "review.yml", {
    ...reviewWorkflowBudgetInputs(config),
    "pr-number": issueNumber,
  });
  await removeReviewLabel(options, issueNumber, label);
  await removeIssueLabelIfPresent(options, issueNumber, gitVibeLabels.readyForApproval.name);
  await removeIssueLabelIfPresent(options, issueNumber, gitVibeLabels.blocked.name);
  await removeIssueLabelIfPresent(options, issueNumber, gitVibeLabels.reviewing.name);
  await removeIssueLabelIfPresent(options, issueNumber, gitVibeInternalLabels.reviewFix.name);
  await addIssueLabel(options, issueNumber, gitVibeLabels.reviewing.name);
  await postQueuedWorkflowComment(options, {
    artifact: "pull-request",
    number: issueNumber,
    reason: labelReason(label),
    workflow: "review.yml",
    ref: dispatch.ref,
    workflowRunUrl: dispatch.html_url,
  });
}

async function removeReviewLabel(
  options: WebhookActionContext,
  issueNumber: string,
  label: string,
): Promise<void> {
  await removeIssueLabel({
    client: options.client,
    issueNumber,
    label,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
  });
}

function reviewLabelRequiresPullRequestBody(label: string): string {
  return `GitVibe removed \`${label}\` because standalone review automation only runs on pull requests.`;
}

function reviewDisabledBody(label: string): string {
  return `GitVibe removed \`${label}\` because \`ai.stages.review-matrix.enabled\` is false in \`${gitVibeConfigPath}\`. The pull request can still be reviewed locally or by enabling the review-matrix stage.`;
}

function reviewConfigErrorBody(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `GitVibe removed \`${label}\` because \`${gitVibeConfigPath}\` could not be read as valid GitVibe config: ${message}`;
}
