import type { CreatedDiscussion } from "../shared/discussions.js";
import { gitVibeLabels } from "../shared/labels.js";
import { sourceDiscussionMarker } from "../shared/traceability.js";

const conversionMarker = "<!-- git-vibe:converted-to-discussion";
const discussionSetupMarker = "<!-- git-vibe:discussion-setup-error";

export interface IntakeIssue {
  body?: string | null;
  html_url?: string;
  labels?: Array<{ name?: string } | string>;
  number?: number | string;
  pull_request?: unknown;
  title?: string;
  user?: { login?: string };
}

export interface IntakeComment {
  body?: string | null;
  id?: number | string;
}

export function isFeatureRequestIssue(issue: IntakeIssue): boolean {
  if (issue.pull_request || hasSourceDiscussionMarker(issue.body)) return false;
  if (issueHasLabel(issue, gitVibeLabels.story.name)) return false;

  const body = normalizedBody(issue.body);
  return featureRequestPatterns.some((pattern) => pattern.test(body));
}

export function hasConversionMarker(issue: IntakeIssue, comments: IntakeComment[] = []): boolean {
  const bodies = [issue.body || "", ...comments.map((comment) => comment.body || "")];
  return bodies.some((body) => body.includes(conversionMarker));
}

export function hasDiscussionSetupMarker(comments: IntakeComment[] = []): boolean {
  return comments.some((comment) => String(comment.body || "").includes(discussionSetupMarker));
}

export function buildDiscussionTitle(issue: IntakeIssue): string {
  return issue.title?.trim() || `Feature request #${issue.number || "unknown"}`;
}

export function buildDiscussionBody(options: {
  issue: IntakeIssue;
  owner: string;
  repo: string;
}): string {
  const issueUrl = issueUrlFor(options);
  const author = options.issue.user?.login ? `@${options.issue.user.login}` : "<unknown>";
  return [
    `<!-- git-vibe:source-issue number=${options.issue.number || ""} url=${issueUrl} -->`,
    `Source issue: ${issueUrl}`,
    `Opened by: ${author}`,
    "",
    "This feature request was opened as an issue. GitVibe moved it to a discussion so the scope, acceptance criteria, and tradeoffs can be refined before implementation.",
    "",
    "## Original Request",
    "",
    options.issue.body || "_No issue body provided._",
  ].join("\n");
}

export function convertedIssueComment(discussion: CreatedDiscussion): string {
  return [
    `${conversionMarker} number=${discussion.number} url=${discussion.url} -->`,
    `GitVibe moved this feature request to Discussion #${discussion.number}: ${discussion.url}`,
    "",
    "Please continue feature refinement there. This issue is closed because implementation issues are created from accepted discussions.",
  ].join("\n");
}

export function discussionSetupErrorComment(error: unknown): string {
  return [
    `${discussionSetupMarker} -->`,
    "GitVibe could not move this feature request to a Discussion.",
    "",
    `Error: ${errorMessage(error)}`,
    "",
    "Enable repository Discussions and ensure GITVIBE_GITHUB_TOKEN has Discussions read/write permission, then reopen or recreate the feature request.",
  ].join("\n");
}

function hasSourceDiscussionMarker(body: string | null | undefined): boolean {
  return String(body || "").includes(sourceDiscussionMarker);
}

function issueHasLabel(issue: IntakeIssue, labelName: string): boolean {
  return (issue.labels || []).some((label) =>
    typeof label === "string" ? label === labelName : label.name === labelName,
  );
}

function issueUrlFor(options: { issue: IntakeIssue; owner: string; repo: string }): string {
  return (
    options.issue.html_url ||
    `https://github.com/${options.owner}/${options.repo}/issues/${options.issue.number || ""}`
  );
}

function normalizedBody(body: string | null | undefined): string {
  return String(body || "").replace(/\r\n/g, "\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const featureRequestPatterns = [
  /###\s*Request type\s*\n+\s*Feature request\b/i,
  /###\s*Issue type\s*\n+\s*Feature request\b/i,
  /###\s*Intake type\s*\n+\s*Feature request\b/i,
];
