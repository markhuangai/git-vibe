import type { ContextPacket, GitVibeConfig, TimelineItem } from "../shared/types.js";

export const defaultSafetyIgnoredAuthors = ["coderabbitai", "coderabbitai[bot]"] as const;

export function safetyIgnoredAuthors(config: GitVibeConfig = {}): string[] {
  return normalizedAuthorList([
    ...defaultSafetyIgnoredAuthors,
    ...(config.safety?.ignored_authors || []),
  ]);
}

export function contextWithoutIgnoredAuthors(
  context: ContextPacket,
  ignoredAuthors: readonly string[] = [],
): ContextPacket {
  const ignored = new Set(normalizedAuthorList(ignoredAuthors));
  if (ignored.size === 0) return context;

  const timeline = context.timeline.filter((item) => !timelineAuthorIgnored(item, ignored));
  return timeline.length === context.timeline.length ? context : { ...context, timeline };
}

function timelineAuthorIgnored(item: TimelineItem, ignoredAuthors: Set<string>): boolean {
  return ignoredTimelineKind(item.kind) && ignoredAuthors.has(normalizedAuthor(item.author));
}

function ignoredTimelineKind(kind: string): boolean {
  return (
    kind === "comment" ||
    kind === "discussion-comment" ||
    kind === "issue-comment" ||
    kind === "pull-request-comment" ||
    kind === "pull-request-review" ||
    kind === "pull-request-review-comment"
  );
}

function normalizedAuthorList(authors: readonly string[]): string[] {
  return Array.from(new Set(authors.map(normalizedAuthor).filter(Boolean)));
}

function normalizedAuthor(author: string): string {
  return author.trim().toLowerCase();
}
