import type { SourceComment, SourceCommentKind } from "./types.js";

const sourceCommentKinds = new Set<SourceCommentKind>([
  "discussion-comment",
  "issue-comment",
  "pull-request-comment",
  "pull-request-review-comment",
]);

export function encodeSourceComment(comment: SourceComment | undefined): string {
  const normalized = normalizeSourceComment(comment);
  return normalized ? JSON.stringify(normalized) : "";
}

export function parseSourceComment(value: string): SourceComment | undefined {
  if (!value.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GITVIBE_SOURCE_COMMENT must be valid JSON.");
  }

  const normalized = normalizeSourceComment(parsed);
  if (!normalized) throw new Error("GITVIBE_SOURCE_COMMENT must describe a valid source comment.");
  return normalized;
}

function normalizeSourceComment(value: unknown): SourceComment | undefined {
  if (!isObject(value)) return undefined;

  const kind = String(value.kind || "");
  if (!sourceCommentKinds.has(kind as SourceCommentKind)) return undefined;

  return {
    body: stringField(value.body),
    id: stringField(value.id),
    kind: kind as SourceCommentKind,
    nodeId: stringField(value.nodeId || value.node_id),
    url: stringField(value.url || value.html_url),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}
