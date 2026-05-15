import { beforeEach, describe, expect, it, vi } from "vitest";

const createOutputValidator = vi.fn();

vi.mock("agentool/output-validator", () => ({ createOutputValidator }));

const { validateOutput } = await import("../src/runner/schemas.ts");

beforeEach(() => {
  createOutputValidator.mockReset();
});

describe("schema validator error paths", () => {
  it("fails when the agentool validator is malformed", async () => {
    createOutputValidator.mockReturnValueOnce({});

    await expect(validateOutput(options("{}"))).rejects.toThrow(
      "agentool output validator is missing an execute function",
    );
  });

  it("fails when the agentool validator returns non-JSON text", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () => "not json"),
    });

    await expect(validateOutput(options("{}"))).rejects.toThrow(
      "agentool output-validator returned a non-JSON result: not json",
    );
  });

  it("reports validator errors with fallback paths and messages", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () =>
        JSON.stringify({ errors: [{}, { message: "must be string", path: "/title" }] }),
      ),
    });

    await expect(validateOutput(options("{}"))).rejects.toThrow(
      "AI output failed test.v1 validation: / ; /title must be string",
    );
  });
});

/**
 * @param {string} content
 * @returns {Parameters<typeof validateOutput>[0]}
 */
function options(content) {
  return {
    content,
    schema: { type: "object" },
    schemaId: "test.v1",
  };
}
