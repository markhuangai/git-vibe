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
      "agentool output-validator returned an unparseable result: not json",
    );
  });

  it("fails when the agentool validator returns an invalid JSON object snippet", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () => "validator output: {not json}"),
    });

    await expect(validateOutput(options("{}"))).rejects.toThrow(
      "agentool output-validator returned invalid JSON",
    );
  });

  it("fails when the agentool validator returns a non-object result", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () => 7),
    });

    await expect(validateOutput(options("{}"))).rejects.toThrow(
      "agentool output-validator returned a malformed result: 7",
    );
  });

  it("truncates long unparseable validator output", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () => "x".repeat(510)),
    });

    await expect(validateOutput(options("{}"))).rejects.toThrow(
      `agentool output-validator returned an unparseable result: ${"x".repeat(500)}...`,
    );
  });
});

describe("schema validator tolerant result paths", () => {
  it("requests all validator errors from agentool", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () => JSON.stringify({ valid: true })),
    });

    await validateOutput(options("{}"));

    expect(createOutputValidator).toHaveBeenCalledWith(
      expect.objectContaining({ errorMode: "all", schemaId: "test.v1" }),
    );
  });

  it("accepts direct object validator results", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () => ({ valid: true })),
    });

    await expect(validateOutput(options("{}"))).resolves.toEqual({});
  });

  it("accepts wrapped validator result text", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () => ({
        content: [
          {
            text: `validation result: ${JSON.stringify({
              message: 'brace } and escaped " quote { inside',
              valid: true,
            })}`,
          },
        ],
      })),
    });

    await expect(validateOutput(options("{}"))).resolves.toEqual({});
  });

  it("accepts result field validator wrappers", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () => ({ result: JSON.stringify({ valid: true }) })),
    });

    await expect(validateOutput(options("{}"))).resolves.toEqual({});
  });

  it("reports validator errors with fallback paths and messages", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () =>
        JSON.stringify({
          errors: [{}, { keyword: "type", message: "must be string", path: "/title" }],
        }),
      ),
    });

    await expect(validateOutput(options("{}"))).rejects.toThrow(
      "AI output failed test.v1 validation: / failed validation; /title must be string [type]",
    );
  });

  it("reports validator messages when no errors are present", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () =>
        JSON.stringify({
          message: "Output does not match the configured schema.",
          valid: false,
        }),
      ),
    });

    await expect(validateOutput(options("{}"))).rejects.toThrow(
      "AI output failed test.v1 validation: Output does not match the configured schema.",
    );
  });

  it("reports unknown validation errors without message details", async () => {
    createOutputValidator.mockReturnValueOnce({
      execute: vi.fn(async () => JSON.stringify({ valid: false })),
    });

    await expect(validateOutput(options("{}"))).rejects.toThrow(
      "AI output failed test.v1 validation: unknown validation error",
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
