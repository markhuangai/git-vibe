import { GitHubClient, splitRepository } from "../shared/github.js";
import type { InstallationTokenProvider } from "./github-app-auth.js";
import { bootstrapRepositoryLabels } from "./labels.js";
import type { WebhookPayload, WebhookRepositoryReference } from "./types.js";

export interface RepositorySetupCheckOptions {
  appAuth: InstallationTokenProvider;
  bootstrappedRepositories: Set<string>;
  client: GitHubClient;
  errorLog: (message: string) => void;
  installationId: number | string;
  log: (message: string) => void;
  owner: string;
  repo: string;
}

export interface InstallationRepositorySetupOptions {
  appAuth: InstallationTokenProvider;
  bootstrappedRepositories: Set<string>;
  client: GitHubClient;
  errorLog: (message: string) => void;
  event: string;
  log: (message: string) => void;
  payload: WebhookPayload;
}

export function isInstallationRepositorySetupEvent(event: string): boolean {
  return event === "installation" || event === "installation_repositories";
}

export async function handleInstallationRepositorySetup(
  options: InstallationRepositorySetupOptions,
): Promise<void> {
  const installationId = options.payload.installation?.id;
  if (!installationId) {
    options.log(`ignored ${options.event}: missing GitHub App installation id`);
    return;
  }

  const repositories = installationSetupRepositories(options.event, options.payload);
  if (!repositories.length) {
    options.log(
      `ignored ${options.event}.${options.payload.action || "unknown"}: no repositories to check`,
    );
    return;
  }

  for (const repository of repositories) {
    const parsed = repositoryReference(repository, options.payload);
    if (!parsed) {
      options.log(
        `ignored ${options.event}.${options.payload.action || "unknown"}: missing repository owner/name`,
      );
      continue;
    }
    await runRepositorySetupChecks({
      appAuth: options.appAuth,
      bootstrappedRepositories: options.bootstrappedRepositories,
      client: options.client,
      errorLog: options.errorLog,
      installationId,
      log: options.log,
      owner: parsed.owner,
      repo: parsed.repo,
    });
  }
}

export async function runRepositorySetupChecks(
  options: RepositorySetupCheckOptions,
): Promise<void> {
  await runLabelSetupCheck(options);
}

async function runLabelSetupCheck(options: RepositorySetupCheckOptions): Promise<void> {
  const repository = `${options.owner}/${options.repo}`;
  try {
    const token = await serverToken(options);
    await bootstrapRepositoryLabels({ ...options, token });
  } catch (error) {
    options.errorLog(
      `repository setup label bootstrap failed for ${repository}: ${summarizeError(error)}. Ensure the GitHub App has Issues write permission.`,
    );
  }
}

function installationSetupRepositories(
  event: string,
  payload: WebhookPayload,
): WebhookRepositoryReference[] {
  if (
    event === "installation" &&
    (payload.action === "created" || payload.action === "new_permissions_accepted")
  ) {
    return payload.repositories || [];
  }
  if (event === "installation_repositories" && payload.action === "added") {
    return payload.repositories_added || [];
  }
  return [];
}

function repositoryReference(
  repository: WebhookRepositoryReference,
  payload: WebhookPayload,
): { owner: string; repo: string } | undefined {
  if (repository.full_name) {
    try {
      return splitRepository(repository.full_name);
    } catch {
      return undefined;
    }
  }
  const owner = repository.owner?.login || payload.installation?.account?.login;
  if (!owner || !repository.name) return undefined;
  return { owner, repo: repository.name };
}

function serverToken(options: RepositorySetupCheckOptions): Promise<string> {
  return options.appAuth.tokenForRepository({
    installationId: options.installationId,
    owner: options.owner,
    profile: "server",
    repo: options.repo,
  });
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
