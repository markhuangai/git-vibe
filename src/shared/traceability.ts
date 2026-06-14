export const sourceDiscussionMarker = "<!-- git-vibe:source-discussion";

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
