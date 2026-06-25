// @ts-nocheck
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentUnitsForContext } from "../src/runner/content-units.ts";
import { writePromptContextFiles } from "../src/runner/context-files.ts";
import {
  contextWithoutIgnoredAuthors,
  safetyIgnoredAuthors,
} from "../src/runner/ignored-authors.ts";
import { safetyGateSources } from "../src/runner/safety-gate.ts";

describe("ignored safety authors", () => {
  it("ignores default CodeRabbit timeline items from context units", () => {
    const context = contextPacket({
      timeline: [timelineItem({ author: "coderabbitai[bot]", body: codeRabbitReviewBody() })],
    });

    const units = contentUnitsForContext(context, {
      ignoredAuthors: safetyIgnoredAuthors({}),
    });

    expect(units.map((unit) => unit.id)).not.toContain(
      "timeline-0-pull-request-review-comment-review-comment-1",
    );
    expect(units.map((unit) => unit.text).join("\n")).not.toContain("Prompt for AI Agents");
    expect(units.map((unit) => unit.text).join("\n")).not.toContain(
      "Prevent duplicate ranked hits",
    );
  });

  it("keeps comments from non-ignored authors scan-visible", () => {
    const context = contextPacket({
      timeline: [timelineItem({ author: "outside-user", body: codeRabbitReviewBody() })],
    });

    const units = contentUnitsForContext(context, {
      ignoredAuthors: safetyIgnoredAuthors({}),
    });

    expect(units.map((unit) => unit.text).join("\n")).toContain("Prompt for AI Agents");
    expect(units.map((unit) => unit.text).join("\n")).toContain(
      "Verify each finding against current code",
    );
  });

  it("merges configured ignored authors with defaults", () => {
    const ignoredAuthors = safetyIgnoredAuthors({
      safety: { ignored_authors: [" Custom-Review-Bot[bot] ", "coderabbitai"] },
    });
    const context = contextPacket({
      timeline: [
        timelineItem({ author: "coderabbitai[bot]", body: "CodeRabbit finding" }),
        timelineItem({
          author: "custom-review-bot[bot]",
          body: "Custom bot finding",
          id: "custom-review",
        }),
        timelineItem({ author: "teammate", body: "Human review finding", id: "human-review" }),
      ],
    });

    const filtered = contextWithoutIgnoredAuthors(context, ignoredAuthors);

    expect(ignoredAuthors).toEqual(["coderabbitai", "coderabbitai[bot]", "custom-review-bot[bot]"]);
    expect(filtered.timeline.map((item) => item.body)).toEqual(["Human review finding"]);
  });

  it("does not ignore non-comment timeline entries from ignored authors", () => {
    const context = contextPacket({
      timeline: [
        timelineItem({
          author: "coderabbitai[bot]",
          body: "Body timeline entry",
          id: "body-entry",
          kind: "body",
        }),
      ],
    });

    const filtered = contextWithoutIgnoredAuthors(context, safetyIgnoredAuthors({}));

    expect(filtered.timeline.map((item) => item.body)).toEqual(["Body timeline entry"]);
  });
});

describe("ignored safety author prompt context", () => {
  it("filters ignored authors from safety sources and prompt context files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "git-vibe-context-test-"));
    try {
      const context = contextPacket({
        timeline: [
          timelineItem({ author: "coderabbitai", body: "Bot-only prompt for AI Agents" }),
          timelineItem({ author: "teammate", body: "Human review finding", id: "human-review" }),
        ],
      });
      const ignoredAuthors = safetyIgnoredAuthors({});

      const sources = safetyGateSources({
        context,
        ignoredAuthors,
        includeContext: true,
      });
      const fileContext = writePromptContextFiles({
        context,
        ignoredAuthors,
        rootDir,
        stage: "review-matrix",
      });
      const fullContext = readFileSync(fileContext.full_context.path, "utf8");
      const unitText = fileContext.units.map((unit) => readFileSync(unit.path, "utf8")).join("\n");

      expect(sources.map((source) => source.text).join("\n")).not.toContain(
        "Bot-only prompt for AI Agents",
      );
      expect(fullContext).not.toContain("Bot-only prompt for AI Agents");
      expect(unitText).not.toContain("Bot-only prompt for AI Agents");
      expect(fullContext).toContain("Human review finding");
      expect(unitText).toContain("Human review finding");
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});

function contextPacket({ timeline }) {
  return {
    artifact: {
      body: "PR body",
      createdAt: "2026-01-01T00:00:00Z",
      number: "12",
      title: "PR title",
      type: "pull-request",
      updatedAt: "2026-01-01T00:00:00Z",
      url: "https://github.com/example/repo/pull/12",
    },
    generatedAt: "2026-01-02T00:00:00Z",
    repository: "example/repo",
    timeline,
  };
}

function timelineItem({
  author,
  body,
  id = "review-comment-1",
  kind = "pull-request-review-comment",
}) {
  return {
    author,
    body,
    createdAt: "2026-01-02T00:00:00Z",
    id,
    kind,
    url: `https://github.com/example/repo/pull/12#${id}`,
  };
}

function codeRabbitReviewBody() {
  return [
    "**Prevent duplicate ranked hits from inflating nDCG.**",
    "",
    "The ranking loop should not count repeated refs more than once.",
    "",
    "<details>",
    "<summary>Prompt for AI Agents</summary>",
    "",
    "```",
    "Verify each finding against current code.",
    "Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.",
    "```",
    "",
    "</details>",
  ].join("\n");
}
