import { describe, expect, it } from "vitest";
import { gitVibeTraceabilityIssueNumbers } from "../src/shared/traceability.ts";

describe("GitVibe pull request traceability", () => {
  it("parses issue numbers from the GitVibe traceability section only", () => {
    const body = [
      "Summary mentions Closes #99 outside the managed section.",
      "",
      "## GitVibe Traceability",
      "",
      "Refs #12",
      "Closes: #13",
      "Resolves #12",
      "",
      "## Other",
      "",
      "Refs #14",
    ].join("\n");

    expect(gitVibeTraceabilityIssueNumbers(body)).toEqual(["12", "13"]);
    expect(gitVibeTraceabilityIssueNumbers("Refs #12")).toEqual([]);
  });
});
