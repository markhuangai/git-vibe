import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  profileContextSystemAddition,
  systemWithProfileContext,
} from "../src/runner/profile-context.ts";

describe("profile context system additions", () => {
  it("omits profile context when a profile does not configure files", () => {
    expect(
      systemWithProfileContext({
        cwd: process.cwd(),
        profile: {},
        profileName: "local_proxy",
        system: "System",
      }),
    ).toBe("System");
  });

  it("renders configured files in order with profile and path metadata", () => {
    const cwd = contextWorkspace({
      "AGENTS.md": "Follow repository rules.",
      'docs/repo "guide".md': "Prefer existing helpers.",
    });

    try {
      const addition = profileContextSystemAddition({
        cwd,
        profile: { context: { files: ["AGENTS.md", 'docs/repo "guide".md'] } },
        profileName: "codex&cli",
      });
      expect(addition).not.toBeNull();
      const rendered = /** @type {string} */ (addition);

      expect(rendered).toContain(
        '<git_vibe_profile_context profile="codex&amp;cli" path="AGENTS.md">',
      );
      expect(rendered).toContain("Follow repository rules.");
      expect(rendered).toContain('path="docs/repo &quot;guide&quot;.md"');
      expect(rendered).toContain("Prefer existing helpers.");
      expect(rendered.indexOf("Follow repository rules.")).toBeLessThan(
        rendered.indexOf("Prefer existing helpers."),
      );
    } finally {
      cleanupWorkspace(cwd);
    }
  });
});

describe("profile context config validation", () => {
  it("rejects malformed profile context config", () => {
    expect(() =>
      profileContextSystemAddition({
        cwd: process.cwd(),
        profile: { context: [] },
        profileName: "local_proxy",
      }),
    ).toThrow("ai.profiles.local_proxy.context must be an object.");
    expect(() =>
      profileContextSystemAddition({
        cwd: process.cwd(),
        profile: { context: { files: [] } },
        profileName: "local_proxy",
      }),
    ).toThrow("ai.profiles.local_proxy.context.files must be a non-empty string array.");
    expect(() =>
      profileContextSystemAddition({
        cwd: process.cwd(),
        profile: { context: { files: [""] } },
        profileName: "local_proxy",
      }),
    ).toThrow("ai.profiles.local_proxy.context.files[0] must be a non-empty string.");
  });

  it("rejects unsafe profile context paths before reading files", () => {
    const cwd = contextWorkspace({});

    try {
      for (const path of ["/etc/passwd", "../AGENTS.md", "docs/../AGENTS.md", "C:\\secrets.md"]) {
        expect(() =>
          profileContextSystemAddition({
            cwd,
            profile: { context: { files: [path] } },
            profileName: "local_proxy",
          }),
        ).toThrow("must be a relative path inside the workspace");
      }
    } finally {
      cleanupWorkspace(cwd);
    }
  });

  it("fails fast for missing and empty configured files", () => {
    const cwd = contextWorkspace({ "EMPTY.md": "  \n" });

    try {
      expect(() =>
        profileContextSystemAddition({
          cwd,
          profile: { context: { files: ["MISSING.md"] } },
          profileName: "local_proxy",
        }),
      ).toThrow("Profile context file does not exist");
      expect(() =>
        profileContextSystemAddition({
          cwd,
          profile: { context: { files: ["EMPTY.md"] } },
          profileName: "local_proxy",
        }),
      ).toThrow("Profile context file must not be empty");
    } finally {
      cleanupWorkspace(cwd);
    }
  });

  it("rejects symlinks and files that resolve outside the workspace", () => {
    const cwd = contextWorkspace({});
    const outside = contextWorkspace({ "context.md": "external host content" });

    try {
      symlinkSync(join(outside, "context.md"), join(cwd, "linked-file.md"));
      symlinkSync(outside, join(cwd, "linked-dir"), "dir");

      expect(() =>
        profileContextSystemAddition({
          cwd,
          profile: { context: { files: ["linked-file.md"] } },
          profileName: "local_proxy",
        }),
      ).toThrow("Profile context file must be a regular file");
      expect(() =>
        profileContextSystemAddition({
          cwd,
          profile: { context: { files: ["linked-dir/context.md"] } },
          profileName: "local_proxy",
        }),
      ).toThrow("Profile context file must stay inside the workspace");
    } finally {
      cleanupWorkspace(cwd);
      cleanupWorkspace(outside);
    }
  });
});

/**
 * @param {Record<string, string>} files
 */
function contextWorkspace(files) {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-profile-context-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  return cwd;
}

/**
 * @param {string} cwd
 */
function cleanupWorkspace(cwd) {
  rmSync(cwd, { force: true, recursive: true });
}
