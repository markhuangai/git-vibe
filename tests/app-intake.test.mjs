import { describe, expect, it, vi } from "vitest";
import {
  checkRepositoryDiscussions,
  createRepositoryDiscussion,
} from "../src/shared/discussions.ts";
import {
  gitVibeLabelList,
  gitVibeLabels,
  isGitVibeLabel,
  isGitVibeRuntimeLabel,
} from "../src/shared/labels.ts";
import { implementationIssueBody } from "../src/shared/traceability.ts";
import {
  buildDiscussionBody,
  buildDiscussionTitle,
  convertedIssueComment,
  discussionSetupErrorComment,
  hasConversionMarker,
  hasDiscussionSetupMarker,
  isFeatureRequestIssue,
} from "../src/app/intake.ts";

describe("GitVibe app intake", () => {
  it("detects feature issue form submissions without using labels", () => {
    expect(
      isFeatureRequestIssue({
        body: "### Request type\n\nFeature request\n\n### Background story\n\nNeed templates.",
        labels: [],
        number: 1,
        title: "Add issue template",
      }),
    ).toBe(true);
    expect(
      isFeatureRequestIssue({
        body: "### Request type\n\nBug report\n\n### Current behavior\n\nBroken.",
        labels: [],
      }),
    ).toBe(false);
  });

  it("does not reconvert implementation issues materialized from discussions", () => {
    expect(
      isFeatureRequestIssue({
        body: implementationIssueBody({
          discussionNumber: "7",
          discussionUrl: "https://github.com/example/repo/discussions/7",
          issueBody: "### Request type\n\nFeature request",
        }),
      }),
    ).toBe(false);
    expect(
      isFeatureRequestIssue({
        body: "### Request type\n\nFeature request",
        labels: [{ name: gitVibeLabels.story.name }],
      }),
    ).toBe(false);
    expect(
      isFeatureRequestIssue({
        body: "### Intake type\r\n\r\nFeature request",
        labels: [gitVibeLabels.story.name],
      }),
    ).toBe(false);
  });

  it("renders discussion and conversion backlinks with hidden markers", () => {
    const issue = {
      body: "### Request type\n\nFeature request",
      html_url: "https://github.com/example/repo/issues/1",
      number: 1,
      title: "Add issue template",
      user: { login: "octocat" },
    };
    const discussionBody = buildDiscussionBody({ issue, owner: "example", repo: "repo" });
    const comment = convertedIssueComment({
      id: "D_kw",
      number: 3,
      url: "https://github.com/example/repo/discussions/3",
    });

    expect(discussionBody).toContain("git-vibe:source-issue");
    expect(discussionBody).toContain("Opened by: @octocat");
    expect(comment).toContain("git-vibe:converted-to-discussion");
    expect(hasConversionMarker(issue, [{ body: comment }])).toBe(true);
  });

  it("renders stable fallback text for sparse issue metadata and setup failures", () => {
    const discussionBody = buildDiscussionBody({
      issue: { body: "", number: "" },
      owner: "example",
      repo: "repo",
    });
    const setupFailure = discussionSetupErrorComment("not enabled");

    expect(buildDiscussionTitle({ number: undefined, title: "  " })).toBe(
      "Feature request #unknown",
    );
    expect(discussionBody).toContain("Source issue: https://github.com/example/repo/issues/");
    expect(discussionBody).toContain("Opened by: <unknown>");
    expect(discussionBody).toContain("_No issue body provided._");
    expect(hasConversionMarker({ body: null }, [{ body: null }])).toBe(false);
    expect(hasDiscussionSetupMarker([{ body: setupFailure }])).toBe(true);
    expect(discussionSetupErrorComment(new Error("missing category"))).toContain(
      "missing category",
    );
    expect(isFeatureRequestIssue({ body: "### Issue type\n\nFeature request" })).toBe(true);
  });
});

describe("GitVibe labels", () => {
  it("defines unique protected GitVibe labels", () => {
    const names = gitVibeLabelList.map((label) => label.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("git-vibe:accept-risk");
    expect(names).toContain("git-vibe:approved");
    expect(names).toContain("gvi:story");
    expect(names).toContain("git-vibe:validate");
    expect(isGitVibeLabel("git-vibe:custom")).toBe(true);
    expect(isGitVibeLabel("gvi:runtime")).toBe(true);
    expect(isGitVibeLabel("bug")).toBe(false);
    expect(isGitVibeRuntimeLabel("gvi:investigating")).toBe(true);
    expect(isGitVibeRuntimeLabel("git-vibe:investigating")).toBe(false);
  });
});

describe("GitHub discussion creation", () => {
  it("checks discussion setup without creating a discussion", async () => {
    const graphql = vi.fn().mockResolvedValueOnce({
      repository: {
        discussionCategories: {
          nodes: [
            { id: "general", name: "General", slug: "general" },
            { id: "ideas", name: "Ideas", slug: "ideas" },
          ],
        },
        id: "repo-id",
      },
    });

    await expect(
      checkRepositoryDiscussions({
        categoryName: "Ideas",
        client: /** @type {any} */ ({ graphql }),
        repository: "example/repo",
        token: "token",
      }),
    ).resolves.toMatchObject({
      categoryName: "Ideas",
      matchedConfiguredCategory: true,
      repository: "example/repo",
    });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("uses the preferred category when creating a repository discussion", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        repository: {
          discussionCategories: {
            nodes: [
              { id: "general", name: "General", slug: "general" },
              { id: "ideas", name: "Ideas", slug: "ideas" },
            ],
          },
          id: "repo-id",
        },
      })
      .mockResolvedValueOnce({
        createDiscussion: {
          discussion: {
            id: "discussion-id",
            number: 9,
            url: "https://github.com/example/repo/discussions/9",
          },
        },
      });

    await expect(
      createRepositoryDiscussion({
        body: "Body",
        categoryName: "Ideas",
        client: /** @type {any} */ ({ graphql }),
        repository: "example/repo",
        title: "Title",
        token: "token",
      }),
    ).resolves.toMatchObject({ number: 9 });
    expect(graphql.mock.calls[1][1]).toMatchObject({
      categoryId: "ideas",
      repositoryId: "repo-id",
    });
  });
});
