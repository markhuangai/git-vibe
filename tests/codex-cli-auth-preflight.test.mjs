// @ts-nocheck
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import sodium from "libsodium-wrappers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn();
const spawnedChildren = [];

vi.mock("node:child_process", () => ({ spawn }));

const { runCodexCliStage } = await import("../src/runner/codex-cli.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };

beforeEach(() => {
  spawn.mockReset();
  spawnedChildren.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_AUTH_JSON: '{"tokens":["old"]}\n' }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("Codex CLI auth preflight", () => {
  it("refreshes and writes back Codex auth before running the stage command", async () => {
    const client = await githubClientWithPublicKey();
    spawn.mockImplementationOnce((_command, _args, childOptions) =>
      mockChildProcess({
        onInput: () => {
          writeFileSync(
            join(childOptions.env.CODEX_HOME, "auth.json"),
            '{"tokens":["preflight"]}\n',
          );
        },
        stdout: "Logged in\n",
      }),
    );
    spawn.mockImplementationOnce((_command, args, childOptions) =>
      mockChildProcess({
        onInput: () => {
          expect(readFileSync(join(childOptions.env.CODEX_HOME, "auth.json"), "utf8")).toBe(
            '{"tokens":["preflight"]}\n',
          );
          writeFileSync(outputPathFrom(args), '{"stage":"validate","status":"completed"}');
        },
        stdout: "codex event\n",
      }),
    );

    await expect(
      runCodexCliStage({
        options: {
          config: {},
          cwd: process.cwd(),
          github: { client, repository: "example/repo", token: "token" },
          maxTurns: 1,
          prompt: "Prompt",
          schema: {},
          schemaId: "schema",
          stage: "validate",
          stageDefinition: stageDefinitions.validate,
          system: "System",
        },
        profile: {
          adapter: "cli-codex",
          auth_json: { from_bundle: "CODEX_AUTH_JSON" },
          model: "gpt-5.5",
        },
        profileName: "codex_cli",
      }),
    ).resolves.toBe('{"stage":"validate","status":"completed"}');

    expect(spawn.mock.calls.map(([command, args]) => [command, args.slice(0, 2)])).toEqual([
      ["codex", ["login", "status"]],
      ["codex", ["exec", "--dangerously-bypass-approvals-and-sandbox"]],
    ]);
    expect(JSON.parse(process.env.GITVIBE_AI_ENV_JSON)).toEqual({
      CODEX_AUTH_JSON: '{"tokens":["preflight"]}\n',
    });
  });
});

async function githubClientWithPublicKey() {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  const publicKey = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);
  return {
    request: vi.fn(async (request) => {
      if (request.method === "GET") return { key: publicKey, key_id: "key-id" };
      return {};
    }),
  };
}

function mockChildProcess({ exitCode = 0, onInput, stderr = "", stdout = "" }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end: vi.fn((input) => {
      onInput?.(input);
      setImmediate(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", exitCode, null);
      });
    }),
  };
  spawnedChildren.push(child);
  return child;
}

function outputPathFrom(args) {
  return args[args.indexOf("--output-last-message") + 1];
}
