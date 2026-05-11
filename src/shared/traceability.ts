export const sourceDiscussionMarker = "<!-- git-vibe:source-discussion";
const reviewFixMarker = "<!-- git-vibe:review-fix";
const reviewFixLinkMarker = "<!-- git-vibe:review-fix-link";

export interface ReviewFixTrace {
  branch: string;
  depth: number;
  parent: string;
  root: string;
}

export interface ReviewFixLink {
  depth: number;
  issue: string;
  parent: string;
  root: string;
}

export interface SourceDiscussionTrace {
  number: string;
  url?: string;
}

export function implementationIssueBody(options: {
  discussionNumber: string;
  discussionUrl: string;
  issueBody: string;
}): string {
  return [
    options.issueBody,
    "",
    `Source discussion: ${options.discussionUrl}`,
    "",
    `${sourceDiscussionMarker} number=${options.discussionNumber} url=${options.discussionUrl} -->`,
  ].join("\n");
}

export function sourceDiscussionTraceFromBody(body: string): SourceDiscussionTrace | undefined {
  const attributes = markerAttributes(body, sourceDiscussionMarker);
  if (!attributes?.number || !isPositiveIssueNumber(attributes.number)) return undefined;
  return { number: attributes.number, url: attributes.url };
}

export function gitVibeBranchName(number: string): string {
  const issueNumber = number.trim();
  if (!/^[1-9]\d*$/.test(issueNumber)) {
    throw new Error(`GitVibe branch requires a numeric issue number, got ${number || "<missing>"}`);
  }

  return `git-vibe/${issueNumber}`;
}

export function reviewFixTraceFromBody(body: string): ReviewFixTrace | undefined {
  const attributes = markerAttributes(body, reviewFixMarker);
  if (!attributes) return undefined;

  const trace = {
    branch: attributes.branch || "",
    depth: Number(attributes.depth),
    parent: attributes.parent || "",
    root: attributes.root || "",
  };
  if (!isPositiveIssueNumber(trace.root) || !isPositiveIssueNumber(trace.parent)) return undefined;
  if (!Number.isInteger(trace.depth) || trace.depth < 1) return undefined;
  if (trace.branch !== gitVibeBranchName(trace.root)) return undefined;
  return trace;
}

export function reviewFixLinkFromBody(body: string): ReviewFixLink | undefined {
  const attributes = markerAttributes(body, reviewFixLinkMarker);
  if (!attributes) return undefined;

  const link = {
    depth: Number(attributes.depth),
    issue: attributes.issue || "",
    parent: attributes.parent || "",
    root: attributes.root || "",
  };
  if (
    !isPositiveIssueNumber(link.root) ||
    !isPositiveIssueNumber(link.parent) ||
    !isPositiveIssueNumber(link.issue)
  ) {
    return undefined;
  }
  if (!Number.isInteger(link.depth) || link.depth < 1) return undefined;
  return link;
}

export function reviewFixIssueMarker(trace: ReviewFixTrace): string {
  return `${reviewFixMarker} root=${trace.root} parent=${trace.parent} branch=${trace.branch} depth=${trace.depth} -->`;
}

export function reviewFixLinkComment(options: {
  depth: number;
  issueNumber: string;
  issueUrl?: string;
  parent: string;
  root: string;
  workflowRunUrl?: string;
}): string {
  return [
    `${reviewFixLinkMarker} root=${options.root} parent=${options.parent} issue=${options.issueNumber} depth=${options.depth} -->`,
    "GitVibe review found required fixes.",
    "",
    `Follow-up review-fix issue: #${options.issueNumber}${options.issueUrl ? ` (${options.issueUrl})` : ""}`,
    options.workflowRunUrl ? `Workflow run: ${options.workflowRunUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function reviewFixIssueBody(options: {
  branch: string;
  commentBody: string;
  depth: number;
  findings: string[];
  parentIssue: string;
  parentUrl?: string;
  references: string[];
  rootIssue: string;
  rootUrl?: string;
  summary: string;
}): string {
  const marker = reviewFixIssueMarker({
    branch: options.branch,
    depth: options.depth,
    parent: options.parentIssue,
    root: options.rootIssue,
  });
  return [
    marker,
    "",
    `Review fix for #${options.rootIssue}.`,
    "",
    `Branch: \`${options.branch}\``,
    `Parent issue: #${options.parentIssue}${options.parentUrl ? ` (${options.parentUrl})` : ""}`,
    options.rootUrl ? `Root issue: #${options.rootIssue} (${options.rootUrl})` : "",
    "",
    "## Review Summary",
    "",
    options.summary,
    "",
    "## Required Fixes",
    "",
    ...listLines(options.findings),
    "",
    "## Review Details",
    "",
    options.commentBody,
    "",
    "## References",
    "",
    ...listLines(options.references),
  ].join("\n");
}

export function gitVibeTraceabilityIssueNumbers(body: string): string[] {
  const section = gitVibeTraceabilitySection(body);
  if (!section) return [];

  return [
    ...new Set(
      [...section.matchAll(/^\s*(?:refs|closes|fixes|resolves):?\s+#([1-9]\d*)\b/gim)].map(
        (match) => match[1],
      ),
    ),
  ];
}

function gitVibeTraceabilitySection(body: string): string {
  const heading = body.match(/^##\s+GitVibe Traceability\s*$/im);
  if (!heading || heading.index === undefined) return "";

  const start = heading.index + heading[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.search(/^##\s+/m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function markerAttributes(body: string, marker: string): Record<string, string> | undefined {
  const start = body.indexOf(marker);
  if (start === -1) return undefined;
  const end = body.indexOf("-->", start);
  if (end === -1) return undefined;

  const content = body.slice(start + marker.length, end);
  return Object.fromEntries(
    [...content.matchAll(/([a-z_]+)=("[^"]*"|[^\s>]+)/g)].map((match) => [
      match[1],
      match[2].replace(/^"|"$/g, ""),
    ]),
  );
}

function isPositiveIssueNumber(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function listLines(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- None provided."];
}
