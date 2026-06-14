// @ts-nocheck
import { describe, expect, it } from "vitest";
import { acceptedRiskContextUnits } from "../src/runner/accepted-risk.ts";
import { acceptedRiskDeltaContentUnits } from "../src/runner/content-units.ts";
import {
  acceptedRiskArtifactContentSha,
  acceptedRiskMetadataBlock,
  acceptedRiskMetadataBodySha,
} from "../src/shared/accepted-risk.ts";

const cutoff = "2026-01-04T12:00:00Z";

describe("accepted-risk source binding", () => {
  it("scans copied accepted-risk metadata in a different post-cutoff comment", () => {
    const context = contextPacket();
    const metadata = acceptedRiskMetadataFor(context);
    const resultBody = blockedResultBody(metadata);
    const acceptedSource = acceptedSourceFor(resultBody);
    context.timeline = [
      timelineComment({ body: resultBody, id: "100", updatedAt: cutoff }),
      timelineComment({
        author: "guest",
        body: copiedMetadataBody(metadata),
        createdAt: "2026-01-04T12:01:00Z",
        id: "copy",
        url: "https://github.com/example/repo/issues/12#issuecomment-copy",
      }),
    ];

    expect(
      acceptedRiskDeltaContentUnits({
        acceptedMetadata: metadata,
        acceptedSource,
        context,
        cutoff,
      }).map((unit) => unit.id),
    ).toEqual(["timeline-1-comment-copy"]);
  });

  it("derives the trusted source before filtering copied metadata", () => {
    const context = contextPacket({ artifact: "issue" });
    const metadata = acceptedRiskMetadataFor(context, { stage: "materialize" });
    context.timeline = [
      timelineComment({
        body: blockedResultBody(metadata, "materialize"),
        id: "100",
        updatedAt: cutoff,
      }),
      timelineComment({
        author: "outside-user",
        authorAssociation: "NONE",
        body: copiedMetadataBody(metadata),
        createdAt: "2026-01-04T12:01:00Z",
        id: "copy",
        url: "https://github.com/example/repo/issues/12#issuecomment-copy",
      }),
    ];

    const units = acceptedRiskContextUnits(context, {
      acceptedRisk: { cutoff, stages: ["materialize"] },
      stage: "materialize",
    });

    expect(units.map((unit) => unit.id)).toEqual(["timeline-1-comment-copy"]);
  });
});

function acceptedRiskMetadataFor(context, { stage = "review-matrix" } = {}) {
  return {
    actor: "maintainer",
    artifact: context.artifact.type,
    artifactContentSha: acceptedRiskArtifactContentSha(context.artifact),
    cutoff,
    number: context.artifact.number,
    stage,
    stages: [stage],
  };
}

function acceptedSourceFor(body) {
  return {
    bodySha: acceptedRiskMetadataBodySha(body),
    id: "100",
    kind: "comment",
    sourceUrl: "https://github.com/example/repo/issues/12#issuecomment-100",
  };
}

function blockedResultBody(metadata, stage = metadata.stage) {
  return [
    `<!-- git-vibe:stage-result stage=${stage} artifact=${metadata.artifact} number=${metadata.number} -->`,
    "## GitVibe Result",
    "",
    "**Status:** `blocked`",
    "",
    "Previously blocked result containing accepted unsafe text",
    acceptedRiskMetadataBlock(metadata),
  ].join("\n");
}

function copiedMetadataBody(metadata) {
  return [
    "New unsafe text with copied accepted-risk metadata",
    acceptedRiskMetadataBlock(metadata),
  ].join("\n\n");
}

function contextPacket({ artifact = "pull-request" } = {}) {
  return {
    artifact: {
      body: "Issue body",
      createdAt: "2026-01-01T00:00:00Z",
      number: "12",
      title: "Issue title",
      type: artifact,
      updatedAt: "2026-01-01T00:00:00Z",
      url: `https://github.com/example/repo/${artifact === "pull-request" ? "pull" : "issues"}/12`,
    },
    generatedAt: "2026-01-02T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
}

function timelineComment({
  author = "gitvibe-for-github[bot]",
  authorAssociation = "NONE",
  body,
  createdAt = "2026-01-04T00:00:00Z",
  id,
  updatedAt,
  url = `https://github.com/example/repo/issues/12#issuecomment-${id}`,
}) {
  return { author, authorAssociation, body, createdAt, id, kind: "comment", updatedAt, url };
}
