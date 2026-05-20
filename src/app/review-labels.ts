import { gitVibeInternalLabels, gitVibeLabels } from "../shared/labels.js";
import {
  addIssueLabel,
  createIssueComment,
  dispatchWorkflow,
  labelReason,
  postQueuedWorkflowComment,
  removeEquivalentIssueLabelIfPresent,
  type WebhookActionContext,
} from "./server-actions.js";
import { removeIssueLabel } from "./labels.js";

export async function handleReviewPullRequestLabel(
  options: WebhookActionContext,
  issueNumber: string,
  label: string,
): Promise<void> {
  if (!options.payload.issue?.pull_request) {
    await removeIssueLabel({
      client: options.client,
      issueNumber,
      label,
      owner: options.owner,
      repo: options.repo,
      token: options.token,
    });
    await createIssueComment(options, issueNumber, reviewLabelRequiresPullRequestBody(label));
    return;
  }

  const dispatch = await dispatchWorkflow(options, "review.yml", {
    "pr-number": issueNumber,
  });
  await removeIssueLabel({
    client: options.client,
    issueNumber,
    label,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
  });
  await removeEquivalentIssueLabelIfPresent(
    options,
    issueNumber,
    gitVibeLabels.readyForApproval.name,
  );
  await removeEquivalentIssueLabelIfPresent(options, issueNumber, gitVibeLabels.blocked.name);
  await removeEquivalentIssueLabelIfPresent(options, issueNumber, gitVibeLabels.reviewing.name);
  await removeEquivalentIssueLabelIfPresent(
    options,
    issueNumber,
    gitVibeInternalLabels.reviewFix.name,
  );
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

function reviewLabelRequiresPullRequestBody(label: string): string {
  return `GitVibe removed \`${label}\` because standalone review automation only runs on pull requests.`;
}
