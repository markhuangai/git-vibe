import { describe, expect, it } from "vitest";
import { createStageLogger, summarizeError } from "../src/lib/logging.ts";

describe("stage logging", () => {
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
});
