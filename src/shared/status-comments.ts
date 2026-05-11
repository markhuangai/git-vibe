type TransientStatusKind = "workflow-queued" | "stage-start";

export interface TransientStatusMarker {
  artifact: "issue" | "pull-request" | "discussion";
  kind: TransientStatusKind;
  number: string;
  run?: string;
  stage?: string;
  workflow?: string;
}

export interface TransientStatusScope {
  artifact: "issue" | "pull-request" | "discussion";
  kind?: TransientStatusKind;
  number: string;
  run?: string;
  stage?: string;
  workflow?: string;
}

export function workflowQueuedMarker(options: {
  artifact: "issue" | "pull-request" | "discussion";
  number: string;
  run?: string;
  workflow: string;
}): string {
  return marker("workflow-queued", {
    artifact: options.artifact,
    number: options.number,
    run: options.run,
    workflow: options.workflow,
  });
}

export function stageStartMarker(options: {
  artifact: "issue" | "pull-request" | "discussion";
  number: string;
  run?: string;
  stage: string;
}): string {
  return marker("stage-start", {
    artifact: options.artifact,
    number: options.number,
    run: options.run,
    stage: options.stage,
  });
}

export function parseTransientStatusMarker(body: string | null | undefined) {
  const match = String(body || "").match(
    /<!--\s*git-vibe:(workflow-queued|stage-start)\s+([^>]*)-->/,
  );
  if (!match) return undefined;

  const attributes = parseAttributes(match[2] || "");
  const artifact = attributes.artifact;
  const number = attributes.number;
  if (!isArtifact(artifact) || !number) return undefined;

  const kind = match[1] as TransientStatusKind;
  if (kind === "workflow-queued" && !attributes.workflow) return undefined;
  if (kind === "stage-start" && !attributes.stage) return undefined;

  return {
    artifact,
    kind,
    number,
    run: attributes.run,
    stage: attributes.stage,
    workflow: attributes.workflow,
  } satisfies TransientStatusMarker;
}

export function matchesTransientStatusScope(
  marker: TransientStatusMarker | undefined,
  scope: TransientStatusScope,
): boolean {
  if (!marker) return false;
  if (marker.artifact !== scope.artifact || marker.number !== scope.number) return false;
  if (scope.kind && marker.kind !== scope.kind) return false;
  if (scope.stage && marker.stage !== scope.stage) return false;
  if (scope.workflow && marker.workflow !== scope.workflow) return false;
  if (scope.run && marker.run && marker.run !== scope.run) return false;
  return true;
}

export function workflowRunIdFromUrl(url: string | undefined): string | undefined {
  return String(url || "").match(/\/actions\/runs\/(\d+)/)?.[1];
}

function marker(kind: TransientStatusKind, attributes: Record<string, string | undefined>): string {
  const fields = Object.entries(attributes)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${markerValue(value)}`);
  return `<!-- git-vibe:${kind} ${fields.join(" ")} -->`;
}

function markerValue(value: string): string {
  return value.replace(/\s+/g, "-").replaceAll(">", "");
}

function parseAttributes(value: string): Record<string, string | undefined> {
  const attributes: Record<string, string | undefined> = {};
  for (const match of value.matchAll(/([a-z][a-z-]*)=([^\s>]+)/g)) {
    attributes[match[1] || ""] = match[2];
  }
  return attributes;
}

function isArtifact(value: string | undefined): value is TransientStatusMarker["artifact"] {
  return value === "issue" || value === "pull-request" || value === "discussion";
}
