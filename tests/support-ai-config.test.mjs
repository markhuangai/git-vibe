// @ts-nocheck
import { describe, expect, it } from "vitest";
import { workspaceConfigWithTestAi } from "./support/ai-config.mjs";

describe("test AI config safety defaults", () => {
  it("only treats root-level safety config as explicit", () => {
    expect(
      workspaceConfigWithTestAi(
        ["ai:", "  notes: |", "    nested text mentioning safety:"].join("\n"),
      ),
    ).toContain("\nsafety:\n  prompt_injection_gate: false\n");

    const nested = workspaceConfigWithTestAi(
      ["custom:", "  safety:", "    prompt_injection_gate: false"].join("\n"),
    );
    const explicit = workspaceConfigWithTestAi(
      ["safety:", "  prompt_injection_gate: true"].join("\n"),
    );

    expect(nested).toContain("\nsafety:\n  prompt_injection_gate: false\n");
    expect(nested).toContain("custom:\n  safety:");
    expect(explicit).not.toContain("prompt_injection_gate: false");
    expect(explicit).toContain("safety:\n  prompt_injection_gate: true");
  });
});
