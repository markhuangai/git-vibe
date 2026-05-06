import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAiStage } from "./ai.js";
import { loadConfig, testCommandsFor } from "./config.js";
import { addDiscussionComment } from "./discussions.js";
import { buildDiscussionContext, buildIssueContext } from "./context.js";
import { GitHubClient, splitRepository } from "./github.js";
import { gitVibeLabels } from "./labels.js";
import type { StageLogger } from "./logging.js";
import { createStageLogger } from "./logging.js";
import { renderPrompts } from "./prompts.js";
import { loadStageSchema, validateOutput } from "./schemas.js";
import { stageDefinitions } from "./stages.js";
import { implementationIssueBody } from "./traceability.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  StageRunResult,
} from "./types.js";

export async function runStage(options: RunnerOptions): Promise<StageRunResult> {
  const logger = createStageLogger(options.stage);
  logger.event("stage.start", {
    dry_run: options.dryRun,
    max_turns: options.maxTurns,
    repository: options.repository,
  });

  const config = loadConfig(options.configPath, options.cwd);
  const definition = stageDefinitions[options.stage];
  const client = new GitHubClient();
  logger.event("context.load.start", { target: definition.target });
  const context = await contextFor({ client, options });
  logger.event("context.load.done", {
    artifact: `${context.artifact.type}#${context.artifact.number}`,
    timeline_items: context.timeline.length,
  });

  const schema = loadStageSchema(definition.schemaFile);
  const prompts = renderPrompts({
    context,
    outputSchema: schema,
    promptDir: definition.promptDir,
    repositoryContext: repositoryContext(options.cwd),
    stageContract: stageContract(options.stage, definition.access, context),
  });
  logger.event("prompt.ready", {
    access: definition.access,
    schema_id: definition.schemaId,
    tools: definition.tools.join(","),
  });

  const contextDir = process.env.RUNNER_TEMP || options.cwd;
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(
    join(contextDir, `git-vibe-${options.stage}-context.json`),
    JSON.stringify(context, null, 2),
  );
  logger.event("context.persisted", { file: `git-vibe-${options.stage}-context.json` });

  const content = options.dryRun
    ? dryRunContent(options.stage, context, logger)
    : await runAiStage({
        config,
        cwd: options.cwd,
        logger,
        maxTurns: options.maxTurns,
        prompt: prompts.prompt,
        schema,
        schemaId: definition.schemaId,
        stageDefinition: definition,
        system: prompts.system,
      });
  logger.event("output.validation.start", { schema_id: definition.schemaId });
  const parsedOutput = await validateOutput({ content, schema, schemaId: definition.schemaId });
  logger.event("output.validation.done", {
    status: String(parsedOutput.status || "completed"),
  });

  await applyDeterministicWrites({ client, config, context, logger, options, parsedOutput });

  logger.event("stage.done", {
    status: String(parsedOutput.status || "completed"),
  });
  return {
    commentBody: String(parsedOutput.comment_body || parsedOutput.summary || ""),
    parsedOutput,
    schemaId: definition.schemaId,
    status: String(parsedOutput.status || "completed"),
    summary: String(parsedOutput.summary || `${options.stage} completed`),
    validationErrors: [],
  };
}

async function contextFor({
  client,
  options,
}: {
  client: GitHubClient;
  options: RunnerOptions;
}): Promise<ContextPacket> {
  const definition = stageDefinitions[options.stage];
  if (
    options.stage === "validate" &&
    process.env.GITVIBE_DISCUSSION_NUMBER &&
    !options.issueNumber
  ) {
    return buildDiscussionContext({
      client,
      discussionNumber: process.env.GITVIBE_DISCUSSION_NUMBER,
      repository: options.repository,
      token: options.token,
    });
  }

  if (definition.target === "discussion") {
    const discussionNumber = process.env.GITVIBE_DISCUSSION_NUMBER || options.issueNumber;
    return buildDiscussionContext({
      client,
      discussionNumber,
      repository: options.repository,
      token: options.token,
    });
  }

  return buildIssueContext({
    client,
    issueNumber: definition.target === "pull-request" ? options.prNumber : options.issueNumber,
    repository: options.repository,
    token: options.token,
    type: definition.target,
  });
}

async function applyDeterministicWrites(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  parsedOutput: JsonObject;
}): Promise<void> {
  if (options.options.dryRun) {
    options.logger.event("writes.skip", { reason: "dry-run" });
    return;
  }

  const status = String(options.parsedOutput.status || "");
  if (status !== "completed") {
    options.logger.event("writes.skip", { reason: "status", status });
    return;
  }

  if (options.options.stage === "implement") await commitImplementation(options);
  if (options.options.stage === "materialize") await createImplementationIssue(options);
  if (options.options.stage === "create-pr") await createPullRequest(options);
}

async function commitImplementation({
  config,
  context,
  logger,
  options,
}: {
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<void> {
  const branch = branchName(context.artifact.number);
  logger.event("git.branch.checkout", { branch });
  execFileSync("git", ["checkout", "-B", branch], { cwd: options.cwd, stdio: "inherit" });
  for (const command of testCommandsFor(config)) {
    logger.event("tests.run", { command });
    execFileSync(command, { cwd: options.cwd, shell: true, stdio: "inherit" });
  }
  logger.event("tests.done");
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: options.cwd })
    .toString()
    .trim();
  if (!status) {
    logger.event("git.no_changes");
    return;
  }
  logger.event("git.status.changed", { files: summarizeGitStatus(status) });

  ensureGitIdentity(options.cwd);
  logger.event("git.commit.start");
  execFileSync("git", ["add", "-A"], { cwd: options.cwd, stdio: "inherit" });
  execFileSync("git", ["commit", "-m", `Implement #${context.artifact.number} with GitVibe`], {
    cwd: options.cwd,
    stdio: "inherit",
  });
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: options.cwd })
    .toString()
    .trim();
  logger.event("git.commit.done", { commit });
  logger.event("token.use", {
    access: "branch-write",
  });
  logger.event("git.push.start", { branch });
  execFileSync(
    "git",
    [
      "-c",
      `http.extraheader=AUTHORIZATION: bearer ${options.token}`,
      "push",
      `https://github.com/${options.repository}.git`,
      branch,
    ],
    { cwd: options.cwd, stdio: "inherit" },
  );
  logger.event("git.push.done", { branch });
}

async function createImplementationIssue({
  client,
  context,
  logger,
  options,
  parsedOutput,
}: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  parsedOutput: JsonObject;
}): Promise<void> {
  logger.event("token.use", {
    access: "publish-write",
  });
  const { owner, repo } = splitRepository(options.repository);
  logger.event("github.issue.create.start");
  const issueBody = implementationIssueBody({
    discussionNumber: context.artifact.number,
    discussionUrl: context.artifact.url,
    issueBody: String(parsedOutput.issue_body || ""),
  });
  const issue = await client.request<{ html_url?: string; number?: number }>({
    body: {
      body: issueBody,
      labels: [gitVibeLabels.story.name],
      title: String(parsedOutput.issue_title || `Implement: ${context.artifact.title}`),
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues`,
    token: options.token,
  });
  logger.event("github.issue.create.done", { number: issue.number, url: issue.html_url });
  if (context.artifact.id && issue.html_url) {
    logger.event("github.discussion.comment.start", { discussion: context.artifact.number });
    await addDiscussionComment({
      body: `GitVibe created implementation issue #${issue.number}: ${issue.html_url}`,
      client,
      discussionId: context.artifact.id,
      token: options.token,
    });
    logger.event("github.discussion.comment.done", { discussion: context.artifact.number });
  }
}

async function createPullRequest({
  client,
  config,
  context,
  logger,
  options,
  parsedOutput,
}: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  parsedOutput: JsonObject;
}): Promise<void> {
  logger.event("token.use", {
    access: "publish-write",
  });
  const { owner, repo } = splitRepository(options.repository);
  const head = branchName(context.artifact.number);
  const title = String(parsedOutput.pr_title || `GitVibe: ${context.artifact.title}`);
  const body = String(
    parsedOutput.pr_body || `${parsedOutput.summary || ""}\n\nRefs #${context.artifact.number}`,
  );
  logger.event("github.pr.lookup", { head });
  const existing = await client.request<Array<{ number?: number }>>({
    method: "GET",
    path: `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(head)}&state=open&per_page=1`,
    token: options.token,
  });
  if (existing[0]?.number) {
    logger.event("github.pr.lookup.done", { found: true, number: existing[0].number });
    logger.event("github.pr.update.start", { number: existing[0].number });
    const updated = await client.request<{ html_url?: string; number?: number }>({
      body: { body, title },
      method: "PATCH",
      path: `/repos/${owner}/${repo}/pulls/${existing[0].number}`,
      token: options.token,
    });
    logger.event("github.pr.update.done", { number: updated.number, url: updated.html_url });
    return;
  }

  logger.event("github.pr.lookup.done", { found: false });
  const base = config.branches?.base || undefined;
  logger.event("github.pr.create.start", { base: base || "repository-default", head });
  const pullRequest = await client.request<{ html_url?: string; number?: number }>({
    body: {
      base,
      body,
      head,
      title,
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls`,
    token: options.token,
  });
  logger.event("github.pr.create.done", { number: pullRequest.number, url: pullRequest.html_url });
}

function ensureGitIdentity(cwd: string): void {
  setGitConfigIfMissing(cwd, "user.name", "git-vibe");
  setGitConfigIfMissing(cwd, "user.email", "git-vibe@users.noreply.github.com");
}

function setGitConfigIfMissing(cwd: string, key: string, value: string): void {
  try {
    const existing = execFileSync("git", ["config", "--get", key], { cwd }).toString().trim();
    if (existing) return;
  } catch {
    // Missing config is expected on fresh runners.
  }

  execFileSync("git", ["config", key, value], { cwd, stdio: "inherit" });
}

function repositoryContext(cwd: string): string {
  return execFileSync("git", ["status", "--short", "--branch"], { cwd }).toString();
}

function summarizeGitStatus(status: string): string {
  const lines = status.split("\n").filter(Boolean);
  const visible = lines.slice(0, 12).join("; ");
  if (lines.length <= 12) return visible;
  return `${visible}; ... +${lines.length - 12} more`;
}

function stageContract(stage: string, access: string, context: ContextPacket): string {
  const deterministicBranch = issueBranchForStage(stage, context);
  const branchRule = deterministicBranch
    ? ` GitVibe owns branch selection; use ${deterministicBranch} exactly and do not invent a branch name.`
    : "";
  return `Stage ${stage} has ${access} access.${branchRule} Return only JSON matching the schema. Call output_validator with the exact final JSON before responding.`;
}

function issueBranchForStage(stage: string, context: ContextPacket): string | undefined {
  if (
    context.artifact.type === "issue" &&
    ["implement", "review-matrix", "create-pr"].includes(stage)
  ) {
    return branchName(context.artifact.number);
  }

  return undefined;
}

function dryRunOutput(stage: string, context: ContextPacket): JsonObject {
  return {
    assumptions: [],
    branch: branchName(context.artifact.number),
    comment_body: `GitVibe dry run for ${stage} on ${context.artifact.type} #${context.artifact.number}.`,
    findings: [],
    issue_body: `Dry-run implementation issue for ${context.artifact.url}`,
    issue_title: `GitVibe dry run: ${context.artifact.title}`,
    next_state: "dry-run",
    pr_body: `Dry-run pull request for ${context.artifact.url}`,
    pr_title: `GitVibe dry run: ${context.artifact.title}`,
    references: [context.artifact.url].filter(Boolean),
    skipped_feedback: [],
    stage,
    status: "completed",
    summary: `Dry run completed for ${stage}.`,
    tests: [],
  };
}

function dryRunContent(stage: string, context: ContextPacket, logger: StageLogger): string {
  logger.event("ai.skip", { reason: "dry-run" });
  return JSON.stringify(dryRunOutput(stage, context));
}

function branchName(number: string): string {
  const issueNumber = number.trim();
  if (!/^[1-9]\d*$/.test(issueNumber)) {
    throw new Error(`GitVibe branch requires a numeric issue number, got ${number || "<missing>"}`);
  }

  return `git-vibe/${issueNumber}`;
}
