import { developWorkflowBudgetInputs } from "../shared/budgets.js";
import { gitVibeConfigPath, stageEnabled } from "../shared/config.js";
import { gitVibeLabels } from "../shared/labels.js";
import {
  createIssueComment,
  dispatchWorkflow,
  issueHasLabel,
  repositoryGitVibeConfig,
  type WebhookActionContext,
} from "./server-actions.js";
import { removeIssueLabel } from "./labels.js";

export async function handleApprovedIssueLabel(
  options: WebhookActionContext,
  issueNumber: string,
  label: string,
): Promise<void> {
  if (!issueHasLabel(options.payload.issue, gitVibeLabels.investigated.name)) {
    await removeApprovedLabel(options, issueNumber, label);
    await createIssueComment(options, issueNumber, approvalRequiresInvestigationBody(label));
    return;
  }

  let config = {};
  let developmentEnabled = true;
  try {
    config = await repositoryGitVibeConfig(options);
    developmentEnabled = stageEnabled(config, "implement");
  } catch (error) {
    await removeApprovedLabel(options, issueNumber, label);
    await createIssueComment(options, issueNumber, approvalConfigErrorBody(label, error));
    return;
  }
  if (!developmentEnabled) {
    await removeApprovedLabel(options, issueNumber, label);
    await createIssueComment(options, issueNumber, approvalDevelopmentDisabledBody(label));
    return;
  }

  await dispatchWorkflow(options, "develop.yml", {
    ...developWorkflowBudgetInputs(config),
    "issue-number": issueNumber,
  });
}

async function removeApprovedLabel(
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

function approvalRequiresInvestigationBody(label: string): string {
  return `GitVibe removed \`${label}\` because this issue has not completed investigation yet. Add \`${gitVibeLabels.investigate.name}\` first; GitVibe will replace it with \`${gitVibeLabels.investigating.name}\` and then \`${gitVibeLabels.investigated.name}\` when the investigation is ready for implementation.`;
}

function approvalDevelopmentDisabledBody(label: string): string {
  return `GitVibe removed \`${label}\` because \`ai.stages.implement.enabled\` is false in \`${gitVibeConfigPath}\`. The issue can still be used for local CLI implementation.`;
}

function approvalConfigErrorBody(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `GitVibe removed \`${label}\` because \`${gitVibeConfigPath}\` could not be read as valid GitVibe config: ${message}`;
}
