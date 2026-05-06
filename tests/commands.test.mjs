import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/app/commands.ts";

describe("parseCommand", () => {
  it("parses the primary GitVibe app mention", () => {
    expect(parseCommand("@git-vibe start")).toMatchObject({
      args: [],
      command: "start",
      trigger: "@git-vibe",
    });
  });

  it("parses slash compatibility commands", () => {
    expect(parseCommand("/git-vibe address-feedback")).toMatchObject({
      args: [],
      command: "address-feedback",
      trigger: "/git-vibe",
    });
  });

  it("normalizes command and trigger case while preserving args", () => {
    expect(parseCommand("  @GIT-VIBE validate extra context  ")).toMatchObject({
      args: ["extra", "context"],
      command: "validate",
      trigger: "@git-vibe",
    });
  });

  it("only parses the first line", () => {
    expect(parseCommand("@git-vibe\nstart")).toMatchObject({
      args: [],
      command: "help",
      trigger: "@git-vibe",
    });
  });

  it("rejects unsupported aliases and inline mentions", () => {
    expect(parseCommand("please @git-vibe start")).toBeNull();
    expect(parseCommand("@gitvibe start")).toBeNull();
    expect(parseCommand("@git-vibeish start")).toBeNull();
    expect(parseCommand("@git-vibe[bot] investigate")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
});
