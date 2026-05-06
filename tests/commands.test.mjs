import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/app/commands.ts";

describe("parseCommand", () => {
  it("parses slash commands", () => {
    expect(parseCommand("/git-vibe address-feedback")).toMatchObject({
      args: [],
      command: "address-feedback",
      trigger: "/git-vibe",
    });
  });

  it("normalizes command and trigger case while preserving args", () => {
    expect(parseCommand("  /GIT-VIBE validate extra context  ")).toMatchObject({
      args: ["extra", "context"],
      command: "validate",
      trigger: "/git-vibe",
    });
  });

  it("only parses the first line", () => {
    expect(parseCommand("/git-vibe\nstart")).toMatchObject({
      args: [],
      command: "help",
      trigger: "/git-vibe",
    });
  });

  it("rejects mention forms, unsupported aliases, and inline commands", () => {
    expect(parseCommand("@git-vibe start")).toBeNull();
    expect(parseCommand("please /git-vibe start")).toBeNull();
    expect(parseCommand("please @git-vibe start")).toBeNull();
    expect(parseCommand("@gitvibe start")).toBeNull();
    expect(parseCommand("@git-vibeish start")).toBeNull();
    expect(parseCommand("@git-vibe[bot] investigate")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
});
