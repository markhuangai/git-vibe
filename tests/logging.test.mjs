import { afterEach, describe, expect, it } from "vitest";
import { createStageLogger, summarizeError } from "../src/runner/logging.ts";

describe("stage logging", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("emits compact structured progress lines", () => {
    /** @type {string[]} */
    const messages = [];
    const logger = createStageLogger("investigate", {
      write: (message) => messages.push(message),
    });

    logger.event("ai.tool.start", {
      detail: "line\nbreak",
      skipped: undefined,
      tool: "read",
    });

    expect(messages).toEqual([
      '[git-vibe] investigate ai.tool.start detail="line break" tool="read"',
    ]);
  });

  it("can be disabled and summarizes errors without stack traces", () => {
    /** @type {string[]} */
    const messages = [];
    const logger = createStageLogger("implement", {
      enabled: false,
      write: (message) => messages.push(message),
    });

    logger.event("stage.start");

    expect(messages).toEqual([]);
    expect(summarizeError(new Error("first line\nsecond line"))).toBe("first line second line");
  });

  it("redacts known secret values from progress lines", () => {
    process.env.GITVIBE_TEST_SECRET = "super-secret-value";
    /** @type {string[]} */
    const messages = [];
    const logger = createStageLogger("validate", {
      write: (message) => messages.push(message),
    });

    logger.event("ai.tool.start", {
      command: "echo super-secret-value github_pat_abc123",
      tool: "bash",
    });

    expect(messages).toEqual([
      '[git-vibe] validate ai.tool.start command="echo <redacted:GITVIBE_TEST_SECRET> <redacted>" tool="bash"',
    ]);
  });
});
