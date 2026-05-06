#!/usr/bin/env node

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { checkRepositoryDiscussions, createRepositoryDiscussion } from "../lib/discussions.js";
import { GitHubClient } from "../lib/github.js";
import { gitVibeLabels } from "../lib/labels.js";
import {
  buildDiscussionBody,
  buildDiscussionTitle,
  convertedIssueComment,
  discussionSetupErrorComment,
  hasConversionMarker,
  hasDiscussionSetupMarker,
  isFeatureRequestIssue,
  type IntakeComment,
} from "./intake.js";
import { ensureGitVibeLabels, isProtectedGitVibeLabel, removeIssueLabel } from "./labels.js";
import { parseCommand } from "./commands.js";

interface WebhookPayload {
  action?: string;
  comment?: { body?: string };
  discussion?: { number?: number };
  issue?: {
    body?: string | null;
    html_url?: string;
    labels?: Array<{ name?: string }>;
    number?: number | string;
    pull_request?: unknown;
    title?: string;
    user?: { login?: string };
  };
  label?: { name?: string };
  repository?: { name: string; owner: { login: string } };
  sender?: { login?: string; type?: string };
}

interface WebhookContext {
  owner: string;
  payload: WebhookPayload;
  repo: string;
  token: string;
}

const port = Number(process.env.PORT || 3000);
const webhookSecret = requiredEnv("GITHUB_WEBHOOK_SECRET");
const githubToken = requiredEnv("GITVIBE_GITHUB_TOKEN");
const dispatchRef = process.env.GITVIBE_DISPATCH_REF || "main";
const discussionCategory = process.env.GITVIBE_DISCUSSION_CATEGORY || "Ideas";
const configuredRepository = process.env.GITHUB_REPOSITORY || "";
const trustedPermissions = new Set(["admin", "maintain", "write"]);
const client = new GitHubClient();
const bootstrappedRepositories = new Set<string>();

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST" || req.url !== "/webhooks") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const body = await readBody(req);
    verifyGitHubSignature(body, firstHeader(req.headers["x-hub-signature-256"]));
    const event = String(req.headers["x-github-event"] || "");
    const payload = JSON.parse(body) as WebhookPayload;
    await handleWebhook(event, payload);
    sendJson(res, 202, { accepted: true, event });
  } catch (error) {
    const httpError = toHttpError(error);
    console.error(`[git-vibe] app error: ${httpError.message}`);
    sendJson(res, httpError.statusCode || 500, { error: httpError.message });
  }
}).listen(port, () => {
  console.log(`[git-vibe] app server listening on :${port}`);
  void runStartupPreflight();
});

async function runStartupPreflight(): Promise<void> {
  if (!configuredRepository) {
    log(
      "startup preflight skipped: GITHUB_REPOSITORY is unavailable; Discussions will be checked when repository webhooks arrive",
    );
    return;
  }

  try {
    const result = await checkRepositoryDiscussions({
      categoryName: discussionCategory,
      client,
      repository: configuredRepository,
      token: githubToken,
    });
    logDiscussionPreflightResult(result);
  } catch (error) {
    console.error(
      `[git-vibe] startup preflight failed: GitHub Discussions unavailable for ${configuredRepository}: ${summarizeError(error)}. Enable repository Discussions, create category "${discussionCategory}", and ensure GITVIBE_GITHUB_TOKEN has Discussions read/write permission.`,
    );
  }
}

function logDiscussionPreflightResult(result: {
  categoryName: string;
  matchedConfiguredCategory: boolean;
  repository: string;
}): void {
  if (result.matchedConfiguredCategory) {
    log(
      `startup preflight ok: GitHub Discussions available for ${result.repository} using category "${result.categoryName}"`,
    );
    return;
  }

  log(
    `startup preflight warning: GitHub Discussions available for ${result.repository}, but category "${discussionCategory}" was not found; using "${result.categoryName}"`,
  );
}

async function handleWebhook(event: string, payload: WebhookPayload): Promise<void> {
  if (!payload.repository) {
    log(`ignored ${event}: missing repository`);
    return;
  }

  const repo = payload.repository.name;
  const owner = payload.repository.owner.login;
  const token = githubToken;
  await bootstrapRepositoryLabels(owner, repo, token);

  if (event === "issues" && payload.action === "opened" && payload.issue) {
    await handleIssueOpened({ owner, payload, repo, token });
    return;
  }

  if (event === "issue_comment" && payload.action === "created" && payload.issue) {
    await handleIssueComment({ owner, payload, repo, token });
    return;
  }

  if (event === "discussion_comment" && payload.action === "created" && payload.discussion) {
    await handleDiscussionComment({ owner, payload, repo, token });
    return;
  }

  if (event === "issues" && payload.action === "labeled" && payload.issue) {
    await handleIssueLabeled({ owner, payload, repo, token });
    return;
  }

  log(`ignored ${event}.${payload.action || "unknown"}`);
}

async function bootstrapRepositoryLabels(
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  const key = `${owner}/${repo}`;
  if (bootstrappedRepositories.has(key)) return;

  await ensureGitVibeLabels({ client, owner, repo, token });
  bootstrappedRepositories.add(key);
  log(`bootstrapped labels for ${key}`);
}

async function handleIssueOpened(options: WebhookContext): Promise<void> {
  if (!isFeatureRequestIssue(options.payload.issue || {})) return;

  const issueNumber = String(options.payload.issue?.number || "");
  const comments = await issueComments(options, issueNumber);
  if (hasConversionMarker(options.payload.issue || {}, comments)) return;

  try {
    await addIssueLabel(options, issueNumber, gitVibeLabels.needsDiscussion.name);
    const discussion = await createRepositoryDiscussion({
      body: buildDiscussionBody({
        issue: options.payload.issue || {},
        owner: options.owner,
        repo: options.repo,
      }),
      categoryName: discussionCategory,
      client,
      repository: `${options.owner}/${options.repo}`,
      title: buildDiscussionTitle(options.payload.issue || {}),
      token: options.token,
    });
    await createIssueComment(options, issueNumber, convertedIssueComment(discussion));
    await closeIssue(options, issueNumber);
  } catch (error) {
    log(`feature issue conversion failed for #${issueNumber}: ${summarizeError(error)}`);
    if (!hasDiscussionSetupMarker(comments)) {
      await createIssueComment(options, issueNumber, discussionSetupErrorComment(error));
    }
  }
}

async function handleIssueComment(options: WebhookContext): Promise<void> {
  const parsed = parseCommand(options.payload.comment?.body?.trim() || "");
  if (!parsed) return;
  await requireTrustedActor(options);

  const issueNumber = String(options.payload.issue?.number || "");
  if (parsed.command === "address-feedback" && options.payload.issue?.pull_request) {
    await dispatchWorkflow(options, "address-feedback.yml", { "pr-number": issueNumber });
    return;
  }

  if (parsed.command === "approve" && !options.payload.issue?.pull_request) {
    await addIssueLabel(options, issueNumber, gitVibeLabels.approved.name);
    await dispatchWorkflow(options, "develop.yml", { "issue-number": issueNumber });
    return;
  }

  const workflow = commandWorkflow(parsed.command);
  if (workflow && !options.payload.issue?.pull_request) {
    await dispatchWorkflow(options, workflow, { "issue-number": issueNumber });
    return;
  }

  log(`recognized command but no dispatch rule matched: ${parsed.raw}`);
}

async function handleDiscussionComment(options: WebhookContext): Promise<void> {
  const parsed = parseCommand(options.payload.comment?.body?.trim() || "");
  if (!parsed) return;
  await requireTrustedActor(options);

  if (
    parsed.command === "summarize" ||
    parsed.command === "materialize" ||
    parsed.command === "validate"
  ) {
    await dispatchWorkflow(options, `${parsed.command}.yml`, {
      "discussion-number": String(options.payload.discussion?.number || ""),
    });
  }
}

async function handleIssueLabeled(options: WebhookContext): Promise<void> {
  const label = options.payload.label?.name || "";
  if (!isProtectedGitVibeLabel(label)) return;

  const issueNumber = String(options.payload.issue?.number || "");

  if (!(await isTrustedActor(options))) {
    await removeIssueLabel({
      client,
      issueNumber,
      label,
      owner: options.owner,
      repo: options.repo,
      token: options.token,
    });
    await createIssueComment(options, issueNumber, protectedLabelRejectionBody(options, label));
    return;
  }

  if (label !== gitVibeLabels.approved.name) return;
  await dispatchWorkflow(options, "develop.yml", { "issue-number": issueNumber });
}

async function requireTrustedActor(options: WebhookContext): Promise<void> {
  if (!(await isTrustedActor(options))) {
    throw Object.assign(
      new Error(
        `actor ${options.payload.sender?.login || "<missing>"} does not have permission to run GitVibe commands`,
      ),
      { statusCode: 403 },
    );
  }
}

async function isTrustedActor(options: WebhookContext): Promise<boolean> {
  const actor = options.payload.sender?.login;
  if (!actor) return false;

  let permission: { permission?: string; role_name?: string };
  try {
    permission = await client.request<{ permission?: string; role_name?: string }>({
      method: "GET",
      path: `/repos/${options.owner}/${options.repo}/collaborators/${actor}/permission`,
      token: options.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return false;
    throw error;
  }

  return (
    trustedPermissions.has(permission.permission || "") ||
    trustedPermissions.has(permission.role_name || "")
  );
}

async function dispatchWorkflow(
  options: WebhookContext,
  workflow: string,
  inputs: Record<string, string>,
): Promise<void> {
  await client.request({
    body: {
      inputs,
      ref: dispatchRef,
    },
    method: "POST",
    path: `/repos/${options.owner}/${options.repo}/actions/workflows/${workflow}/dispatches`,
    token: options.token,
  });
}

async function createIssueComment(
  options: WebhookContext,
  issueNumber: string,
  body: string,
): Promise<void> {
  await client.request({
    body: { body },
    method: "POST",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}/comments`,
    token: options.token,
  });
}

async function issueComments(
  options: WebhookContext,
  issueNumber: string,
): Promise<IntakeComment[]> {
  return client.request<IntakeComment[]>({
    method: "GET",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}/comments?per_page=100`,
    token: options.token,
  });
}

async function closeIssue(options: WebhookContext, issueNumber: string): Promise<void> {
  await client.request({
    body: { state: "closed", state_reason: "completed" },
    method: "PATCH",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}`,
    token: options.token,
  });
}

async function addIssueLabel(
  options: WebhookContext,
  issueNumber: string,
  label: string,
): Promise<void> {
  await client.request({
    body: { labels: [label] },
    method: "POST",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}/labels`,
    token: options.token,
  });
}

function commandWorkflow(command: string): string | null {
  if (command === "investigate") return "investigate.yml";
  if (command === "validate") return "validate.yml";
  if (command === "start") return "develop.yml";
  return null;
}

function verifyGitHubSignature(body: string, signatureHeader: string | undefined): void {
  if (!signatureHeader?.startsWith("sha256=")) {
    throw Object.assign(new Error("missing GitHub signature"), { statusCode: 401 });
  }

  const expected = createHmac("sha256", webhookSecret).update(body).digest("hex");
  const actual = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw Object.assign(new Error("invalid GitHub signature"), { statusCode: 401 });
  }
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function protectedLabelRejectionBody(options: WebhookContext, label: string): string {
  return `GitVibe removed \`${label}\` because @${options.payload.sender?.login || "<missing>"} is not allowed to control GitVibe automation labels for this repository.`;
}

function sendJson(
  res: import("node:http").ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredEnv(name: string): string {
  const value = process.env[name] || "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function toHttpError(error: unknown): Error & { statusCode?: number } {
  return error instanceof Error
    ? (error as Error & { statusCode?: number })
    : new Error(String(error));
}

function log(message: string): void {
  console.log(`[git-vibe] ${message}`);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
