import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * @typedef {import("../src/shared/github.ts").GitHubClient} GitHubClient
 * @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket
 * @typedef {import("../src/shared/types.ts").RunnerOptions} RunnerOptions
 * @typedef {import("../src/shared/types.ts").StageRunResult} StageRunResult
 * @typedef {import("../src/runner/logging.ts").StageLogger} StageLogger
 */

const execFileSync = vi.fn();
const addDiscussionComment = vi.fn();
const closeDiscussion = vi.fn();
const applyStageLabelTransition = vi.fn();
const cleanupStageStatusComments = vi.fn();
const publishFeedbackInvestigationReplies = vi.fn();
const publishStageResultComment = vi.fn();
const appendIssueTraceability = vi.fn((body) => `traced:${body}`);
const handleReviewFixRequired = vi.fn(async ({ result }) => ({
  ...result,
  summary: "review fix required",
}));
const issueBranch = vi.fn(() => "git-vibe/12");
const issueChain = vi.fn(async () => []);
const branchForWriteStage = vi.fn(() => "feature");
const runnerBaseBranch = vi.fn(async () => ({
  base: "main",
  defaultBranch: "main",
  targetsDefault: true,
}));
const runValidationCommand = vi.fn();
const validationRepairAttemptsFor = vi.fn(() => 1);

vi.mock("node:child_process", () => ({ execFileSync }));
vi.mock("../src/shared/discussions.js", () => ({ addDiscussionComment, closeDiscussion }));
vi.mock("../src/runner/stage-publishing.js", () => ({
  applyStageLabelTransition,
  cleanupStageStatusComments,
  publishFeedbackInvestigationReplies,
  publishStageResultComment,
}));
vi.mock("../src/runner/review-fix.js", () => ({
  appendIssueTraceability,
  handleReviewFixRequired,
  issueBranch,
  issueChain,
}));
vi.mock("../src/runner/stage-branches.js", () => ({
  branchForWriteStage,
  runnerBaseBranch,
}));
vi.mock("../src/runner/validation.js", () => ({
  runValidationCommand,
  validationRepairAttemptsFor,
}));

const { applyDeterministicWrites, markPullRequestFeedbackInvestigationStarted } =
  await import("../src/runner/stage-writes.ts");

/** @typedef {Parameters<typeof applyDeterministicWrites>[0]} ApplyOptions */

beforeEach(() => {
  for (const mock of [
    execFileSync,
    addDiscussionComment,
    closeDiscussion,
    applyStageLabelTransition,
    cleanupStageStatusComments,
    publishFeedbackInvestigationReplies,
    publishStageResultComment,
    appendIssueTraceability,
    handleReviewFixRequired,
    issueBranch,
    issueChain,
    branchForWriteStage,
    runnerBaseBranch,
    runValidationCommand,
    validationRepairAttemptsFor,
  ]) {
    mock.mockClear();
  }
  appendIssueTraceability.mockImplementation((body) => `traced:${body}`);
  handleReviewFixRequired.mockImplementation(async ({ result }) => ({
    ...result,
    summary: "review fix required",
  }));
  issueBranch.mockReturnValue("git-vibe/12");
  issueChain.mockResolvedValue([]);
  branchForWriteStage.mockReturnValue("feature");
  runnerBaseBranch.mockResolvedValue({
    base: "main",
    defaultBranch: "main",
    targetsDefault: true,
  });
  runValidationCommand.mockImplementation(() => undefined);
  validationRepairAttemptsFor.mockReturnValue(1);
  execFileSync.mockReturnValue(Buffer.from(""));
  addDiscussionComment.mockResolvedValue(undefined);
  closeDiscussion.mockResolvedValue(undefined);
});

describe("stage deterministic writes", () => {
  it("skips writes for dry runs and blocked results", async () => {
    await expect(applyDeterministicWrites(options({ dryRun: true }))).resolves.toMatchObject({
      status: "completed",
    });

    const blocked = result({ status: "blocked" });
    await expect(applyDeterministicWrites(options({ result: blocked }))).resolves.toBe(blocked);

    expect(publishStageResultComment).toHaveBeenCalledTimes(1);
    expect(applyStageLabelTransition).toHaveBeenCalledTimes(1);
  });

  it("delegates issue review fixes before normal publishing", async () => {
    const reviewResult = result({
      parsedOutput: { next_state: "changes_required", status: "completed" },
    });

    await expect(
      applyDeterministicWrites(
        options({ result: reviewResult, runner: runner({ stage: "review-matrix" }) }),
      ),
    ).resolves.toMatchObject({ summary: "review fix required" });

    expect(cleanupStageStatusComments).toHaveBeenCalledTimes(1);
    expect(handleReviewFixRequired).toHaveBeenCalledTimes(1);
  });

  it("publishes PR investigation replies for read-only investigate runs", async () => {
    await applyDeterministicWrites(
      options({
        context: context("pull-request"),
        result: result({ parsedOutput: { next_state: "no-fixes-needed", status: "completed" } }),
        runner: runner({ stage: "investigate" }),
      }),
    );

    expect(publishFeedbackInvestigationReplies).toHaveBeenCalledTimes(1);
    expect(publishStageResultComment).toHaveBeenCalledTimes(1);
    expect(applyStageLabelTransition).toHaveBeenCalledTimes(1);
  });
});

describe("stage deterministic materialize writes", () => {
  it("materializes implementation issues from discussion output", async () => {
    const client = createClient([
      { html_url: "https://github.com/example/repo/issues/44", number: 44 },
      {},
    ]);

    await applyDeterministicWrites(
      options({
        client,
        context: context("discussion", { id: "discussion-node" }),
        result: result({
          parsedOutput: {
            issues: [
              {
                acceptance_criteria: ["It works."],
                background: "Implement this.",
                backpressure_commands: ["corepack pnpm test"],
                blocked_by: [],
                parallel_group: "default",
                requirements: ["Build the implementation."],
                review_guidelines: ["Check the source discussion link."],
                title: "Implementation issue",
              },
            ],
            status: "completed",
          },
        }),
        runner: runner({ stage: "materialize" }),
      }),
    );

    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/repos/example/repo/issues",
      }),
    );
    expect(addDiscussionComment).toHaveBeenCalledTimes(1);
    expect(closeDiscussion).toHaveBeenCalledTimes(1);
  });

  it("materializes split implementation issues with dependency details", async () => {
    const client = createClient([
      { html_url: "https://github.com/example/repo/issues/44", number: 44 },
      { number: 45 },
    ]);

    await applyDeterministicWrites(
      options({
        client,
        context: context("discussion", { id: "discussion-node" }),
        result: result({
          parsedOutput: {
            issues: [
              {
                acceptance_criteria: ["First issue passes."],
                background: "Build the first slice.",
                backpressure_commands: ["corepack pnpm test"],
                blocked_by: [],
                parallel_group: "foundation",
                requirements: ["Create the shared support."],
                review_guidelines: ["Review the source discussion."],
                title: "Build foundation",
              },
              {
                acceptance_criteria: ["Second issue passes."],
                background: "Build the dependent slice.",
                backpressure_commands: ["corepack pnpm test"],
                blocked_by: ["#44"],
                parallel_group: "follow-up",
                requirements: ["Use the shared support."],
                review_guidelines: ["Check dependency order."],
                title: "Build follow-up",
              },
            ],
            status: "completed",
          },
        }),
        runner: runner({ stage: "materialize" }),
      }),
    );

    const issueBodies = client.request.mock.calls.map(([request]) => request.body?.body || "");
    expect(issueBodies.join("\n")).toContain("Blocked by: #44");
    expect(addDiscussionComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: [
          "GitVibe created implementation issues:",
          "- #44: https://github.com/example/repo/issues/44",
          "- #45",
        ].join("\n"),
      }),
    );
  });
});

describe("stage deterministic materialize fallback writes", () => {
  it("logs close failures after materializing a discussion issue", async () => {
    const client = createClient([
      { html_url: "https://github.com/example/repo/issues/44", number: 44 },
    ]);
    const stageLogger = logger();
    closeDiscussion.mockRejectedValueOnce(new Error("close unavailable"));

    await expect(
      applyDeterministicWrites(
        options({
          client,
          context: context("discussion", { id: "discussion-node" }),
          logger: stageLogger,
          result: result({
            parsedOutput: {
              issues: [
                {
                  acceptance_criteria: ["It works."],
                  background: "Implement this.",
                  backpressure_commands: [],
                  blocked_by: [],
                  parallel_group: "default",
                  requirements: ["Build the implementation."],
                  review_guidelines: [],
                  title: "Implementation issue",
                },
              ],
              status: "completed",
            },
          }),
          runner: runner({ stage: "materialize" }),
        }),
      ),
    ).resolves.toMatchObject({ status: "completed" });

    expect(stageLogger.event).toHaveBeenCalledWith(
      "github.discussion.close.failed",
      expect.objectContaining({ discussion: "12", error: "close unavailable" }),
    );
  });

  it("materializes fallback issue defaults from sparse issue drafts", async () => {
    const client = createClient([{}]);

    await applyDeterministicWrites(
      options({
        client,
        context: context("discussion", { id: "discussion-node" }),
        result: result({
          parsedOutput: {
            issues: [{}],
            status: "completed",
          },
        }),
        runner: runner({ stage: "materialize" }),
      }),
    );

    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ title: "Implement accepted discussion" }),
      }),
    );
    expect(client.request.mock.calls[0][0].body.body).toContain("Parallel group: `default`");
    expect(addDiscussionComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "GitVibe created implementation issue an issue." }),
    );
  });

  it("skips materialize issue creation when output has no issue drafts", async () => {
    const client = createClient();

    await applyDeterministicWrites(
      options({
        client,
        context: context("discussion", { id: "discussion-node" }),
        result: result({ parsedOutput: { issues: "invalid", status: "completed" } }),
        runner: runner({ stage: "materialize" }),
      }),
    );

    expect(client.request).not.toHaveBeenCalled();
    expect(addDiscussionComment).not.toHaveBeenCalled();
    expect(closeDiscussion).not.toHaveBeenCalled();
  });
});

describe("stage deterministic pull request writes", () => {
  it("creates or updates pull requests and exposes pull request outputs", async () => {
    const updateClient = createClient([
      [{ number: 7 }],
      { html_url: "https://github.com/example/repo/pull/7", number: 7 },
    ]);
    const updatedResult = await applyDeterministicWrites(
      options({ client: updateClient, runner: runner({ stage: "create-pr" }) }),
    );

    expect(updateClient.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PATCH", path: "/repos/example/repo/pulls/7" }),
    );
    expect(updatedResult.parsedOutput).toMatchObject({
      pr_number: "7",
      pr_url: "https://github.com/example/repo/pull/7",
    });

    const createClientWithoutNumber = createClient([
      [],
      { html_url: "https://github.com/example/repo/pull/new" },
    ]);
    await applyDeterministicWrites(
      options({ client: createClientWithoutNumber, runner: runner({ stage: "create-pr" }) }),
    );

    expect(createClientWithoutNumber.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/repos/example/repo/pulls" }),
    );
  });
});

describe("stage deterministic git commits", () => {
  it("uses the shared branch update path for issue implementation", async () => {
    await applyDeterministicWrites(options({ runner: runner({ stage: "implement" }) }));

    expect(applyStageLabelTransition).toHaveBeenCalledTimes(1);
    expect(branchForWriteStage).toHaveBeenCalledWith(
      "implement",
      expect.objectContaining({ artifact: expect.objectContaining({ type: "issue" }) }),
    );
    expect(publishStageResultComment).not.toHaveBeenCalled();
  });

  it("uses the shared branch update path for pull request feedback remediation", async () => {
    const client = createClient();

    await applyDeterministicWrites(
      options({
        client,
        context: context("pull-request", {
          pullRequestHead: { branch: "feature", repository: "example/repo" },
        }),
        runner: runner({ stage: "address-pr-feedback" }),
      }),
    );

    expect(applyStageLabelTransition).toHaveBeenCalledTimes(1);
    expect(branchForWriteStage).toHaveBeenCalledWith(
      "address-pr-feedback",
      expect.objectContaining({ artifact: expect.objectContaining({ type: "pull-request" }) }),
    );
    expect(publishStageResultComment).toHaveBeenCalledTimes(1);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("commits only after validation succeeds and changed files are staged", async () => {
    execFileSync.mockImplementation((command, args) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined === "git status --porcelain") return Buffer.from(" M file.js\n");
      if (joined === "git diff --cached --name-status") return Buffer.from("M\tfile.js\n");
      if (joined === "git rev-parse --short HEAD") return Buffer.from("abc123\n");
      return Buffer.from("");
    });

    await applyDeterministicWrites(options({ runner: runner({ stage: "address-pr-feedback" }) }));

    expect(runValidationCommand).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit"]),
      expect.any(Object),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["push"]),
      expect.any(Object),
    );
  });

  it("returns repaired blocked results without committing", async () => {
    const failure = Object.assign(new Error("failed"), {
      failure: { command: "check", exitCode: 1, output: "bad" },
    });
    runValidationCommand.mockImplementation(() => {
      throw failure;
    });
    const repaired = result({ status: "blocked" });
    const repair = vi.fn(async () => repaired);

    await expect(
      applyDeterministicWrites(
        options({
          config: { tests: { commands: ["check"] } },
          repair,
          runner: runner({ stage: "implement" }),
        }),
      ),
    ).resolves.toBe(repaired);

    expect(repair).toHaveBeenCalledWith(failure.failure, 1, 1);
    expect(publishStageResultComment).toHaveBeenCalledTimes(1);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("pull request feedback investigation labels", () => {
  it("removes stale PR labels and adds investigating", async () => {
    const client = createClient();
    client.request
      .mockRejectedValueOnce(new Error("404 Not Found"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await markPullRequestFeedbackInvestigationStarted({
      client,
      context: context("pull-request"),
      logger: logger(),
      options: runner({ stage: "investigate" }),
    });

    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/repos/example/repo/issues/12/labels",
      }),
    );
    expect(client.request.mock.calls.map(([request]) => request.path)).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/issues/12/labels/gvi%3Aready-for-approval",
        "/repos/example/repo/issues/12/labels/git-vibe%3Aready-for-approval",
        "/repos/example/repo/issues/12/labels/gvi%3Ablocked",
        "/repos/example/repo/issues/12/labels/git-vibe%3Ablocked",
      ]),
    );
  });

  it("rethrows unexpected label removal failures", async () => {
    const client = createClient();
    client.request.mockRejectedValueOnce(new Error("500"));

    await expect(
      markPullRequestFeedbackInvestigationStarted({
        client,
        context: context("pull-request"),
        logger: logger(),
        options: runner({ stage: "investigate" }),
      }),
    ).rejects.toThrow("500");
  });
});

/**
 * @param {Partial<ApplyOptions> & { dryRun?: boolean; runner?: RunnerOptions }} [overrides]
 * @returns {ApplyOptions}
 */
function options(overrides = {}) {
  const { dryRun, options: explicitRunner, runner: runnerValue, ...rest } = overrides;
  const runnerOptions = { ...(explicitRunner || runnerValue || runner({ stage: "validate" })) };
  if (typeof dryRun === "boolean") runnerOptions.dryRun = dryRun;

  return /** @type {ApplyOptions} */ ({
    client: createClient(),
    config: { tests: { commands: [] } },
    context: context("issue"),
    logger: logger(),
    options: runnerOptions,
    repair: vi.fn(async () => result()),
    result: result(),
    transientComments: [],
    ...rest,
  });
}

/**
 * @param {"issue" | "discussion" | "pull-request"} type
 * @param {Partial<ContextPacket["artifact"]>} [artifactOverrides]
 * @returns {ContextPacket}
 */
function context(type, artifactOverrides = {}) {
  return /** @type {ContextPacket} */ ({
    artifact: {
      body: "",
      id: type === "discussion" ? "discussion-node" : undefined,
      number: "12",
      title: "Title",
      type,
      url: `https://github.com/example/repo/${type}/12`,
      ...artifactOverrides,
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  });
}

/**
 * @param {Partial<RunnerOptions>} [overrides]
 * @returns {RunnerOptions}
 */
function runner(overrides = {}) {
  return /** @type {RunnerOptions} */ ({
    cwd: "/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "12",
    repository: "example/repo",
    stage: "validate",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  });
}

/**
 * @param {Partial<StageRunResult>} [overrides]
 * @returns {StageRunResult}
 */
function result(overrides = {}) {
  return /** @type {StageRunResult} */ ({
    commentBody: "Comment",
    parsedOutput: { status: "completed" },
    schemaId: "schema.v1",
    status: "completed",
    summary: "Summary",
    validationErrors: [],
    ...overrides,
  });
}

/** @returns {StageLogger} */
function logger() {
  return /** @type {StageLogger} */ ({ event: vi.fn() });
}

/**
 * @param {unknown[]} [responses]
 * @returns {GitHubClient & { request: ReturnType<typeof vi.fn> }}
 */
function createClient(responses = []) {
  const queue = [...responses];
  return /** @type {GitHubClient & { request: ReturnType<typeof vi.fn> }} */ ({
    request: vi.fn(async () => (queue.length ? queue.shift() : {})),
  });
}
