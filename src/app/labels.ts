import { GitHubClient } from "../shared/github.js";
import { type GitVibeLabelDefinition, gitVibeLabelList, isGitVibeLabel } from "../shared/labels.js";

export async function ensureGitVibeLabels(options: {
  client: GitHubClient;
  owner: string;
  repo: string;
  token: string;
}): Promise<void> {
  for (const label of gitVibeLabelList) {
    await ensureLabel({ ...options, label });
  }
}

export async function bootstrapRepositoryLabels(options: {
  bootstrappedRepositories: Set<string>;
  client: GitHubClient;
  log: (message: string) => void;
  owner: string;
  repo: string;
  token: string;
}): Promise<void> {
  const key = `${options.owner}/${options.repo}`;
  if (options.bootstrappedRepositories.has(key)) return;

  await ensureGitVibeLabels(options);
  options.bootstrappedRepositories.add(key);
  options.log(`bootstrapped labels for ${key}`);
}

export async function removeIssueLabel(options: {
  client: GitHubClient;
  issueNumber: string;
  label: string;
  owner: string;
  repo: string;
  token: string;
}): Promise<void> {
  await options.client.request({
    method: "DELETE",
    path: `/repos/${options.owner}/${options.repo}/issues/${options.issueNumber}/labels/${encodeURIComponent(options.label)}`,
    token: options.token,
  });
}

export function isProtectedGitVibeLabel(label: string): boolean {
  return isGitVibeLabel(label);
}

async function ensureLabel(options: {
  client: GitHubClient;
  label: GitVibeLabelDefinition;
  owner: string;
  repo: string;
  token: string;
}): Promise<void> {
  try {
    await options.client.request({
      body: {
        color: options.label.color,
        description: options.label.description,
        name: options.label.name,
      },
      method: "POST",
      path: `/repos/${options.owner}/${options.repo}/labels`,
      token: options.token,
    });
  } catch (error) {
    if (isAlreadyExistsError(error)) return;
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("422");
}
