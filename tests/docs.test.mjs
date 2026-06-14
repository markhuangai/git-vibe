import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("documentation workflow descriptions", () => {
  it("links long-form docs to the canonical wiki", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain("https://github.com/markhuangai/git-vibe/wiki");
    expect(readme).toContain("Security-and-Permissions");
    expect(readme).toContain("Configuration#repository-prompt-additions");
    expect(readme).toContain("Workflows-and-Lifecycle");
  });

  it("keeps Mermaid workflow docs aligned with the no-code workflow", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain("H --> I[Comment, label, or issue]");
    expect(readme).toContain("I --> J[Human implementation, review, and merge]");
    expect(readme).not.toContain("K[Create or update PR]");
    expect(readme).not.toContain("N[Update existing PR branch]");
  });

  it("documents the local git-vibe-setup installer behavior", () => {
    const readme = readFileSync("README.md", "utf8");
    const exampleReadme = readFileSync("examples/consumer/README.md", "utf8");

    expect(readme).toContain("git-vibe-setup");
    expect(readme).toContain("stops without writing if any target file");
    expect(readme).toContain("already exists.");
    expect(readme).toContain("pins generated reusable");
    expect(readme).toContain("workflow refs to that release tag");
    expect(exampleReadme).toContain("fails closed if GitHub release");
    expect(exampleReadme).toContain("lookup or target-file validation");
    expect(exampleReadme).toContain("It will not overwrite existing target files.");
  });
});
