// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import {
  handleInstallationRepositorySetup,
  isInstallationRepositorySetupEvent,
} from "../src/app/repository-setup.ts";
import { createAppAuth, createClient } from "./support/server-app.mjs";

describe("repository setup installation event routing", () => {
  it("recognizes installation repository setup events", () => {
    expect(isInstallationRepositorySetupEvent("installation")).toBe(true);
    expect(isInstallationRepositorySetupEvent("installation_repositories")).toBe(true);
    expect(isInstallationRepositorySetupEvent("issues")).toBe(false);
  });

  it("ignores installation events without repositories to check", async () => {
    const options = setupOptions({
      payload: { action: "created" },
    });

    await handleInstallationRepositorySetup(options);

    expect(options.log).toHaveBeenCalledWith(
      "ignored installation: missing GitHub App installation id",
    );
    expect(options.appAuth.tokenForRepository).not.toHaveBeenCalled();

    const removed = setupOptions({
      event: "installation_repositories",
      payload: { action: "removed", installation: { id: 123 } },
    });
    await handleInstallationRepositorySetup(removed);
    expect(removed.log).toHaveBeenCalledWith(
      "ignored installation_repositories.removed: no repositories to check",
    );

    const createdWithoutRepositories = setupOptions({
      payload: { action: "created", installation: { id: 123 } },
    });
    await handleInstallationRepositorySetup(createdWithoutRepositories);
    expect(createdWithoutRepositories.log).toHaveBeenCalledWith(
      "ignored installation.created: no repositories to check",
    );

    const addedWithoutRepositories = setupOptions({
      event: "installation_repositories",
      payload: { action: "added", installation: { id: 123 } },
    });
    await handleInstallationRepositorySetup(addedWithoutRepositories);
    expect(addedWithoutRepositories.log).toHaveBeenCalledWith(
      "ignored installation_repositories.added: no repositories to check",
    );
  });

  it("skips malformed repository references and checks valid account-owned entries", async () => {
    const options = setupOptions({
      payload: {
        action: "new_permissions_accepted",
        installation: { account: { login: "example" }, id: 123 },
        repositories: [{ full_name: "bad" }, { name: "repo" }],
      },
    });

    await handleInstallationRepositorySetup(options);

    expect(options.log).toHaveBeenCalledWith(
      "ignored installation.new_permissions_accepted: missing repository owner/name",
    );
    expect(options.appAuth.tokenForRepository).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 123, owner: "example", repo: "repo" }),
    );
  });

  it("checks repository references that include an owner", async () => {
    const options = setupOptions({
      payload: {
        action: "created",
        installation: { id: 123 },
        repositories: [
          { owner: { login: "direct" } },
          { name: "repo", owner: { login: "direct" } },
        ],
      },
    });

    await handleInstallationRepositorySetup(options);

    expect(options.log).toHaveBeenCalledWith(
      "ignored installation.created: missing repository owner/name",
    );
    expect(options.appAuth.tokenForRepository).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 123, owner: "direct", repo: "repo" }),
    );
  });

  it("logs non-error repository setup failures", async () => {
    const options = setupOptions({
      client: createClient({ labelError: "denied" }),
    });

    await handleInstallationRepositorySetup(options);

    expect(options.errorLog).toHaveBeenCalledWith(
      "repository setup label bootstrap failed for example/repo: denied. Ensure the GitHub App has Issues write permission.",
    );
  });
});

function setupOptions(overrides = {}) {
  return {
    appAuth: createAppAuth(),
    bootstrappedRepositories: new Set(),
    client: createClient(),
    errorLog: vi.fn(),
    event: "installation",
    log: vi.fn(),
    payload: {
      action: "created",
      installation: { id: 123 },
      repositories: [{ full_name: "example/repo" }],
    },
    ...overrides,
  };
}
