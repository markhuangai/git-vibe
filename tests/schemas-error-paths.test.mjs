import { describe, expect, it } from "vitest";
import { validateOutput } from "../src/runner/schemas.ts";
import { structuredOutputText } from "../src/runner/sdk-output.ts";

describe("schema validator error paths", () => {
  it("fails on invalid JSON", async () => {
    await expect(validateOutput(options("not json"))).rejects.toThrow(
      "AI output failed test.v1 validation: invalid JSON:",
    );
  });

  it("fails on non-object JSON", async () => {
    await expect(validateOutput(options("[]"))).rejects.toThrow(
      "AI output failed test.v1 validation: output must be a JSON object",
    );
  });

  it("reports all schema validation errors", async () => {
    await expect(
      validateOutput(options(JSON.stringify({ count: "many", extra: true }))),
    ).rejects.toThrow("AI output failed test.v1 validation:");
    await expect(
      validateOutput(options(JSON.stringify({ count: "many", extra: true }))),
    ).rejects.toThrow("/ must have required property 'title' [required]");
    await expect(
      validateOutput(options(JSON.stringify({ count: "many", extra: true }))),
    ).rejects.toThrow("/ must NOT have additional properties [additionalProperties]");
    await expect(
      validateOutput(options(JSON.stringify({ count: "many", extra: true }))),
    ).rejects.toThrow("/count must be number [type]");
  });

  it("uses fallback text for validation errors without messages", async () => {
    await expect(
      validateOutput({
        content: JSON.stringify({ title: "ok" }),
        schema: {
          properties: {
            title: { type: "string", unknownKeywordForTest: true },
          },
          type: "object",
        },
        schemaId: "test.v1",
      }),
    ).resolves.toEqual({ title: "ok" });
  });
});

describe("schema validator success paths", () => {
  it("returns parsed objects", async () => {
    await expect(
      validateOutput(options(JSON.stringify({ count: 1, title: "Ready" }))),
    ).resolves.toEqual({
      count: 1,
      title: "Ready",
    });
  });
});

describe("SDK structured output rendering", () => {
  it("handles nullish, string, and object structured outputs", () => {
    expect(structuredOutputText(undefined)).toBeUndefined();
    expect(structuredOutputText(null)).toBeUndefined();
    expect(structuredOutputText("  value  ")).toBe("value");
    expect(structuredOutputText({ ok: true })).toBe('{"ok":true}');
  });
});

/** @param {string} content */
function options(content) {
  return {
    content,
    schema: {
      additionalProperties: false,
      properties: {
        count: { type: "number" },
        title: { type: "string" },
      },
      required: ["title"],
      type: "object",
    },
    schemaId: "test.v1",
  };
}
