#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitHubClient, splitRepository, type GitHubRequest } from "../../shared/github.js";
import { gitVibeLabels } from "../../shared/labels.js";
import { redactLogText } from "../logging.js";

interface GitHubRequester {
  request<T extends Record<string, unknown> | unknown[] = Record<string, unknown>>(
    request: GitHubRequest,
  ): Promise<T>;
}

export interface MarkBlockedRuntime {
  client?: GitHubRequester;
  env?: NodeJS.ProcessEnv;
  error?: (message: string) => void;
  log?: (message: string) => void;
}

interface MarkBlockedOptions {
  client: GitHubRequester;
  dryRun: boolean;
  issueNumber: string;
  owner: string;
  repo: string;
  token: string;
}

export async function markBlocked(runtime: MarkBlockedRuntime = {}): Promise<number> {
  const env = runtime.env ?? process.env;
  const error = runtime.error ?? console.error;
  const log = runtime.log ?? console.log;

  try {
    const token = requiredEnv(env, "GITVIBE_GITHUB_TOKEN");
    const repository = requiredEnv(env, "GITHUB_REPOSITORY");
    const issueNumber = requiredEnv(env, "GITVIBE_ISSUE_NUMBER");
    const { owner, repo } = splitRepository(repository);
    const dryRun = isTrue(env.GITVIBE_DRY_RUN);

    if (dryRun) {
      log(`dry-run: would mark issue #${issueNumber} blocked after an incomplete run`);
      return 0;
    }

    const client = runtime.client ?? new GitHubClient();
    await markIssueBlocked({ client, dryRun, issueNumber, owner, repo, token });
    log(`marked issue #${issueNumber} blocked after an incomplete run`);
    return 0;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    error(redactLogText(`failed to mark issue blocked: ${message}`));
    return 1;
  }
}

export async function markIssueBlocked(options: MarkBlockedOptions): Promise<void> {
  if (options.dryRun) return;

  await removeIssueLabelIfPresent(options, gitVibeLabels.inProgress.name);
  await removeIssueLabelIfPresent(options, gitVibeLabels.approved.name);
  await addIssueLabel(options, gitVibeLabels.blocked.name);
}

async function removeIssueLabelIfPresent(
  options: MarkBlockedOptions,
  label: string,
): Promise<void> {
  try {
    await options.client.request({
      method: "DELETE",
      path: `/repos/${options.owner}/${options.repo}/issues/${options.issueNumber}/labels/${encodeURIComponent(label)}`,
      token: options.token,
    });
  } catch (caught) {
    if (!isNotFound(caught)) throw caught;
  }
}

async function addIssueLabel(options: MarkBlockedOptions, label: string): Promise<void> {
  await options.client.request({
    body: { labels: [label] },
    method: "POST",
    path: `/repos/${options.owner}/${options.repo}/issues/${options.issueNumber}/labels`,
    token: options.token,
  });
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isTrue(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function isNotFound(caught: unknown): boolean {
  return caught instanceof Error && /\b404\b/.test(caught.message);
}

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!moduleUrl) {
    return Boolean(entrypoint && /(?:^|[/\\])mark-blocked\.(?:c?js|ts)$/.test(entrypoint));
  }
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}

if (isDirectRun("", process.argv[1])) {
  markBlocked().then((code) => {
    process.exit(code);
  });
}
