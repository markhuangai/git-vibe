import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("GitVibe app deployment boundary", () => {
  it("deploys only prerelease images passed by the release workflow", () => {
    const workflow = readWorkflow(".github/workflows/app-deploy.yml");
    const content = readFileSync(".github/workflows/app-deploy.yml", "utf8");
    const deploySteps = /** @type {Array<{ uses?: string, run?: string }>} */ (
      workflow.jobs?.deploy?.steps || []
    );

    expect(workflow.on?.workflow_call?.inputs?.release_tag).toMatchObject({
      required: true,
      type: "string",
    });
    expect(workflow.on?.release).toBeUndefined();
    expect(workflow.on?.push).toBeUndefined();
    expect(workflow.on?.workflow_dispatch).toBeUndefined();
    expect(workflow.permissions).toMatchObject({
      contents: "read",
      packages: "read",
    });
    expect(workflow.env?.GITVIBE_IMAGE).toBe(
      "ghcr.io/markhuangai/git-vibe:${{ inputs.release_tag }}",
    );
    expect(workflow.jobs?.build).toBeUndefined();
    expect(
      deploySteps.some((step) => step.run?.includes("app-deploy only accepts prerelease tags")),
    ).toBe(true);
    expect(content).toContain("[0-9A-Za-z][0-9A-Za-z._-]*");
    expect(deploySteps.some((step) => step.uses === "docker/login-action@v3")).toBe(true);
    expect(deploySteps.some((step) => step.run?.includes("docker compose"))).toBe(true);
    expect(content).not.toContain("docker/build-push-action");
    expect(content).toContain("secrets.GITVIBE_APP_PRIVATE_KEY");
    expect(content).not.toContain("GITHUB_APP_PRIVATE_KEY");
    expect(content).not.toContain("github.sha");
    expect(content).not.toContain("latest");
  });

  it("builds the app image without bundled runner runtime assets", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    expect(packageJson.scripts["build:app"]).toBe("tsc --project tsconfig.build.json");
    expect(dockerfile).toContain("corepack pnpm build:app");
    expect(dockerfile).toContain("COPY --from=build /app/dist/app ./dist/app");
    expect(dockerfile).toContain("COPY --from=build /app/dist/shared ./dist/shared");
    expect(dockerfile).not.toContain("COPY --from=build /app/app ./app");
    expect(dockerfile).not.toContain("COPY --from=build /app/dist ./dist");
    expect(dockerfile).not.toContain("COPY --from=build /app/prompts ./prompts");
    expect(dockerfile).not.toContain("COPY --from=build /app/schemas ./schemas");
  });
});

describe("GitVibe release deployment boundary", () => {
  it("publishes prereleases from dev and stable releases from main", () => {
    const workflow = readWorkflow(".github/workflows/release.yml");
    const content = readFileSync(".github/workflows/release.yml", "utf8");
    const releaseSteps = /** @type {Array<{ name?: string, if?: string }>} */ (
      workflow.jobs?.release?.steps || []
    );

    expect(workflow.on?.workflow_dispatch?.inputs?.release_tag).toMatchObject({
      default: "v3",
      required: true,
    });
    expect(workflow.permissions).toMatchObject({
      contents: "write",
      packages: "write",
    });
    expect(workflow.on?.workflow_dispatch?.inputs?.source_image_tag).toBeUndefined();
    expect(workflow.jobs?.release?.env).toMatchObject({
      BUILDX_CONFIG: "/tmp/.docker-buildx",
      DOCKER_CONTEXT: "default",
    });
    expect(content).toContain("prerelease=true");
    expect(content).toContain("[0-9A-Za-z][0-9A-Za-z._-]*");
    expect(content).toContain("required_ref=refs/heads/dev");
    expect(content).toContain("prerelease=false");
    expect(content).toContain("required_ref=refs/heads/main");
    expect(content).toContain("Stable releases must run from main; prereleases must run from dev.");
    expect(content).toContain("collaborators/$REQUEST_ACTOR/permission");
    expect(content).toContain('permission" != "admin"');
    expect(content).toContain("Detect app-impacting changes");
    expect(content).toContain("app_changed=false");
    expect(content).toContain("src/app/*|src/shared/*");
    expect(content).toContain("Docker image: not built; no app-impacting changes");
    expect(content).toContain("docker buildx inspect rootless --bootstrap");
    expect(content).toContain("docker buildx rm rootless");
    expect(content).toContain("docker buildx create --name rootless --use default");
    expect(content).not.toContain("docker/login-action");
    expect(content).toContain("docker buildx build --push");
    expect(content).not.toContain("docker pull");
    expect(content).not.toContain("docker tag");
    expect(content).not.toContain("source_image");
    expect(content).toContain('latest_image="$image:latest"');
    expect(content).toContain("release_flags+=(--prerelease --latest=false)");
    expect(content).toContain("release_flags+=(--latest)");
    expect(content).toContain("docker buildx prune --force --filter until=48h");
    expect(content).toContain("gh release create");
    expect(content).toContain("--generate-notes");
    for (const stepName of [
      "Set up Docker builder",
      "Build and push release image",
      "Clean Docker release artifacts",
    ]) {
      expect(releaseSteps.find((step) => step.name === stepName)?.if).toBe(
        "steps.app_changes.outputs.app_changed == 'true'",
      );
    }
    expect(workflow.jobs?.release?.outputs).toMatchObject({
      app_changed: "${{ steps.app_changes.outputs.app_changed }}",
      prerelease: "${{ steps.release.outputs.prerelease }}",
      release_tag: "${{ steps.release.outputs.release_tag }}",
    });
    expect(workflow.jobs?.["deploy-prerelease"]).toMatchObject({
      needs: "release",
      if: "needs.release.outputs.prerelease == 'true' && needs.release.outputs.app_changed == 'true'",
      uses: "./.github/workflows/app-deploy.yml",
      with: {
        release_tag: "${{ needs.release.outputs.release_tag }}",
      },
      secrets: "inherit",
    });
  });
});

/** @param {string} file */
function readWorkflow(file) {
  return parse(readFileSync(file, "utf8"));
}
