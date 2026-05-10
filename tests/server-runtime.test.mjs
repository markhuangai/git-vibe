import { describe, expect, it, vi } from "vitest";
import { isDirectRun, startServerFromEnv } from "../src/app/server.ts";

describe("GitVibe app server runtime configuration", () => {
  it("starts from environment configuration and validates required server secrets", async () => {
    expect(() => startServerFromEnv({ GITVIBE_GITHUB_TOKEN: "token" })).toThrow(
      "GITHUB_WEBHOOK_SECRET is required",
    );

    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = startServerFromEnv({
      GITHUB_WEBHOOK_SECRET: "secret",
      GITVIBE_GITHUB_TOKEN: "token",
      PORT: "0",
    });
    await new Promise((resolve) => server.on("listening", resolve));
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
    consoleLog.mockRestore();
  });

  it("detects direct execution by module URL", () => {
    expect(isDirectRun(new URL("../src/app/server.ts", import.meta.url).href, undefined)).toBe(
      false,
    );
    expect(isDirectRun("", "/tmp/server.js")).toBe(true);
  });
});
