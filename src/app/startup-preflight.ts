import { checkRepositoryDiscussions } from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import type { InstallationTokenProvider } from "./github-app-auth.js";
import { bootstrapRepositoryLabels } from "./labels.js";

export interface StartupPreflightOptions {
  appAuth: InstallationTokenProvider;
  bootstrappedRepositories: Set<string>;
  client: GitHubClient;
  configuredRepository: string;
  discussionCategory: string;
  errorLog: (message: string) => void;
  log: (message: string) => void;
}

export async function runStartupPreflight(options: StartupPreflightOptions): Promise<void> {
  if (!options.configuredRepository) {
    options.log(
      "startup preflight skipped: GITHUB_REPOSITORY is unavailable; labels and Discussions will be checked when repository webhooks arrive",
    );
    return;
  }

  await runLabelPreflight(options);
  await runDiscussionPreflight(options);
}

async function runLabelPreflight(options: StartupPreflightOptions): Promise<void> {
  try {
    const { owner, repo } = splitRepository(options.configuredRepository);
    const token = await options.appAuth.tokenForRepository({ owner, profile: "server", repo });
    await bootstrapRepositoryLabels({ ...options, owner, repo, token });
  } catch (error) {
    options.errorLog(
      `startup label bootstrap failed for ${options.configuredRepository}: ${summarizeError(error)}. Ensure the GitHub App has Issues write permission.`,
    );
  }
}

async function runDiscussionPreflight(options: StartupPreflightOptions): Promise<void> {
  try {
    const { owner, repo } = splitRepository(options.configuredRepository);
    const token = await options.appAuth.tokenForRepository({ owner, profile: "server", repo });
    const result = await checkRepositoryDiscussions({
      categoryName: options.discussionCategory,
      client: options.client,
      repository: options.configuredRepository,
      token,
    });
    logDiscussionPreflightResult(options, result);
  } catch (error) {
    options.errorLog(
      `startup preflight failed: GitHub Discussions unavailable for ${options.configuredRepository}: ${summarizeError(error)}. Enable repository Discussions, create category "${options.discussionCategory}", and ensure the GitHub App has Discussions read/write permission.`,
    );
  }
}

function logDiscussionPreflightResult(
  options: StartupPreflightOptions,
  result: { categoryName: string; matchedConfiguredCategory: boolean; repository: string },
): void {
  if (result.matchedConfiguredCategory) {
    options.log(
      `startup preflight ok: GitHub Discussions available for ${result.repository} using category "${result.categoryName}"`,
    );
    return;
  }

  options.log(
    `startup preflight warning: GitHub Discussions available for ${result.repository}, but category "${options.discussionCategory}" was not found; using "${result.categoryName}"`,
  );
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
