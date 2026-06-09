import { createHash } from "node:crypto";
import { parseStage } from "./stages.js";
import type { ContextPacket, Stage } from "./types.js";

export interface AcceptedRiskArtifactContent {
  body?: string | null;
  title?: string | null;
}

export interface AcceptedRiskMetadata {
  actor?: string;
  artifact: ContextPacket["artifact"]["type"];
  artifactContentSha: string;
  artifactSha?: string;
  cutoff: string;
  number: string;
  stage: Stage;
  stages: Stage[];
}

export interface AcceptedRiskMetadataSource {
  bodySha: string;
  databaseId?: string;
  id?: string;
  kind?: string;
  sourceUrl?: string;
}

const metadataStartPattern = /<!--\s*git-vibe:accepted-risk-metadata\s+([^>]*)-->/;
const metadataBlockPattern =
  /\n*<!--\s*git-vibe:accepted-risk-metadata\s+[^>]*-->[\s\S]*?<!--\s*git-vibe:accepted-risk-end\s*-->\n*/g;

export function acceptedRiskArtifactContentSha(content: AcceptedRiskArtifactContent): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedArtifactContent(content)))
    .digest("hex");
}

export function acceptedRiskMetadataBodySha(body: string | null | undefined): string {
  return createHash("sha256")
    .update(
      String(body || "")
        .replace(metadataBlockPattern, "")
        .trimEnd(),
    )
    .digest("hex");
}

export function appendAcceptedRiskMetadataBlock(
  body: string,
  metadata: AcceptedRiskMetadata,
): string {
  return `${body.replace(metadataBlockPattern, "").trimEnd()}\n\n${acceptedRiskMetadataBlock(metadata)}`;
}

export function acceptedRiskMetadataBlock(metadata: AcceptedRiskMetadata): string {
  return [
    acceptedRiskMetadataMarker(metadata),
    "### Accepted Risk",
    "",
    `${inlineCode(metadata.actor || "<unknown>")} accepted this prompt-injection input risk for one rerun.`,
    `Accepted at: ${inlineCode(metadata.cutoff)}`,
    `Accepted stages: ${metadata.stages.map(inlineCode).join(", ")}`,
    `Artifact title/body SHA: ${inlineCode(metadata.artifactContentSha)}`,
    metadata.artifactSha ? `Pull request head SHA: ${inlineCode(metadata.artifactSha)}` : "",
    "<!-- git-vibe:accepted-risk-end -->",
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseAcceptedRiskMetadata(
  body: string | null | undefined,
): AcceptedRiskMetadata | undefined {
  const match = String(body || "").match(metadataStartPattern);
  if (!match) return undefined;
  const attributes = parseAttributes(match[1] || "");
  const artifact = artifactField(attributes.artifact);
  const number = stringField(attributes.number);
  const cutoff = stringField(attributes.cutoff);
  const artifactContentSha = stringField(attributes["artifact-content-sha"]);
  if (!artifact || !number || !cutoff || !artifactContentSha || !attributes.stage) {
    return undefined;
  }
  try {
    const stage = parseStage(attributes.stage);
    return {
      actor: stringField(attributes.actor),
      artifact,
      artifactContentSha,
      artifactSha: stringField(attributes["artifact-sha"]),
      cutoff,
      number,
      stage,
      stages: stagesField(attributes.stages, stage),
    };
  } catch {
    return undefined;
  }
}

function normalizedArtifactContent(content: AcceptedRiskArtifactContent): {
  body: string;
  title: string;
} {
  return {
    body: typeof content.body === "string" ? content.body : "",
    title: typeof content.title === "string" ? content.title : "",
  };
}

function acceptedRiskMetadataMarker(metadata: AcceptedRiskMetadata): string {
  return `<!-- git-vibe:accepted-risk-metadata ${[
    attribute("stage", metadata.stage),
    attribute("stages", metadata.stages.join(",")),
    attribute("artifact", metadata.artifact),
    attribute("number", metadata.number),
    attribute("cutoff", metadata.cutoff),
    attribute("actor", metadata.actor || ""),
    attribute("artifact-content-sha", metadata.artifactContentSha),
    attribute("artifact-sha", metadata.artifactSha || ""),
  ]
    .filter(Boolean)
    .join(" ")} -->`;
}

function attribute(name: string, value: string): string {
  return value ? `${name}=${encodeURIComponent(value)}` : "";
}

function parseAttributes(value: string): Record<string, string | undefined> {
  const attributes: Record<string, string | undefined> = {};
  for (const match of value.matchAll(/([a-z][a-z-]*)=([^\s>]+)/g)) {
    attributes[match[1] || ""] = decodeURIComponent(match[2] || "");
  }
  return attributes;
}

function artifactField(value: string | undefined): AcceptedRiskMetadata["artifact"] | undefined {
  if (value === "discussion" || value === "issue" || value === "pull-request") return value;
  return undefined;
}

function stagesField(value: string | undefined, fallback: Stage): Stage[] {
  const stages = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseStage);
  return stages.length ? stages : [fallback];
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function stringField(value: string | undefined): string | undefined {
  const text = String(value || "").trim();
  return text || undefined;
}
