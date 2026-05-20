import { addDiscussionComment, closeDiscussion } from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeLabels } from "../shared/labels.js";
import { implementationIssueBody } from "../shared/traceability.js";
import { discussionReplyToId } from "./discussion-replies.js";
import type { StageLogger } from "./logging.js";
import type { ContextPacket, JsonObject, RunnerOptions } from "../shared/types.js";

interface MaterializedIssueDraft {
  acceptance_criteria: string[];
  background: string;
  backpressure_commands: string[];
  blocked_by: string[];
  parallel_group: string;
  requirements: string[];
  review_guidelines: string[];
  title: string;
}

type CreatedIssue = JsonObject & {
  html_url?: string;
  number?: number;
};

export async function createImplementationIssues({
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
  logger.event("token.use");
  const { owner, repo } = splitRepository(options.repository);
  const createdIssues: CreatedIssue[] = [];
  for (const draft of materializedIssueDrafts(parsedOutput)) {
    logger.event("github.issue.create.start");
    const issue = await client.request<CreatedIssue>({
      body: {
        body: implementationIssueBody({
          discussionNumber: context.artifact.number,
          discussionUrl: context.artifact.url,
          issueBody: materializedIssueBody(draft),
        }),
        labels: [gitVibeLabels.story.name],
        title: draft.title,
      },
      method: "POST",
      path: `/repos/${owner}/${repo}/issues`,
      token: options.token,
    });
    createdIssues.push(issue);
    logger.event("github.issue.create.done", { number: issue.number, url: issue.html_url });
  }
  if (context.artifact.id && createdIssues.length > 0) {
    logger.event("github.discussion.comment.start", { discussion: context.artifact.number });
    await addDiscussionComment({
      body: createdIssuesComment(createdIssues),
      client,
      discussionId: context.artifact.id,
      replyToId: discussionReplyToId(options, context),
      token: options.token,
    });
    logger.event("github.discussion.comment.done", { discussion: context.artifact.number });
    await closeSourceDiscussion({
      client,
      discussionId: context.artifact.id,
      logger,
      number: context.artifact.number,
      runner: options,
    });
  }
}

function materializedIssueDrafts(parsedOutput: JsonObject): MaterializedIssueDraft[] {
  return Array.isArray(parsedOutput.issues)
    ? parsedOutput.issues.filter(isObject).map(materializedIssueDraft)
    : [];
}

function materializedIssueDraft(value: JsonObject): MaterializedIssueDraft {
  return {
    acceptance_criteria: stringArray(value.acceptance_criteria),
    background: String(value.background || "").trim(),
    backpressure_commands: stringArray(value.backpressure_commands),
    blocked_by: stringArray(value.blocked_by),
    parallel_group: String(value.parallel_group || "default").trim() || "default",
    requirements: stringArray(value.requirements),
    review_guidelines: stringArray(value.review_guidelines),
    title: String(value.title || "Implement accepted discussion").trim(),
  };
}

function materializedIssueBody(issue: MaterializedIssueDraft): string {
  return cleanLines([
    "## Background",
    issue.background,
    "",
    "## Requirements",
    ...bulletLines(issue.requirements),
    "",
    "## Acceptance Criteria",
    ...bulletLines(issue.acceptance_criteria),
    "",
    "## Dependencies",
    `Parallel group: \`${issue.parallel_group}\``,
    issue.blocked_by.length ? `Blocked by: ${issue.blocked_by.join(", ")}` : "Blocked by: None",
    "",
    "## Backpressure Commands",
    ...bulletLines(issue.backpressure_commands),
    "",
    "## Review Guidelines",
    ...bulletLines(issue.review_guidelines),
  ]).join("\n");
}

function createdIssuesComment(issues: CreatedIssue[]): string {
  if (issues.length === 1) {
    return `GitVibe created implementation issue ${issueLink(issues[0])}.`;
  }
  return [
    "GitVibe created implementation issues:",
    ...issues.map((issue) => `- ${issueLink(issue)}`),
  ].join("\n");
}

function issueLink(issue: CreatedIssue): string {
  const number = issue.number ? `#${issue.number}` : "an issue";
  return issue.html_url ? `${number}: ${issue.html_url}` : number;
}

function bulletLines(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- None"];
}

function cleanLines(lines: string[]): string[] {
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function closeSourceDiscussion(options: {
  client: GitHubClient;
  discussionId: string;
  logger: StageLogger;
  number: string;
  runner: RunnerOptions;
}): Promise<void> {
  options.logger.event("github.discussion.close.start", { discussion: options.number });
  try {
    await closeDiscussion({
      client: options.client,
      discussionId: options.discussionId,
      token: options.runner.token,
    });
    options.logger.event("github.discussion.close.done", { discussion: options.number });
  } catch (error) {
    options.logger.event("github.discussion.close.failed", {
      discussion: options.number,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
