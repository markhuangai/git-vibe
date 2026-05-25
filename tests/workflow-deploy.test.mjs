import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("GitVibe app deployment boundary", () => {
  it("deploys the app only when app, shared, package, or deploy files change", () => {
    const workflow = readWorkflow(".github/workflows/app-deploy.yml");
    const paths = workflow.on?.push?.paths || [];
    const buildSteps = /** @type {Array<{ uses?: string, with?: Record<string, unknown> }>} */ (
      workflow.jobs?.build?.steps || []
    );
    const tags = String(
      buildSteps.find((step) => step.uses === "docker/build-push-action@v6")?.with?.tags || "",
    );

    expect(workflow.on?.push?.branches).toEqual(["main"]);
    expect(paths).toContain("src/app/**");
    expect(paths).toContain("src/shared/**");
    expect(paths).toContain(".github/workflows/release.yml");
    expect(paths).not.toContain("src/**");
    expect(paths).not.toContain("src/runner/**");
    expect(paths).not.toContain("prompts/**");
    expect(paths).not.toContain("schemas/**");
    expect(tags).toContain("${{ env.GITVIBE_IMAGE }}");
    expect(tags).not.toContain("latest");
  });

  it("builds the app image without bundled runner runtime assets", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    expect(packageJson.scripts["build:app"]).toBe("tsc --project tsconfig.build.json");
    expect(dockerfile).toContain("corepack pnpm build:app");
    expect(dockerfile).toContain("COPY --from=build /app/dist/app ./dist/app");
    expect(dockerfile).toContain("COPY --from=build /app/dist/shared ./dist/shared");
    expect(dockerfile).not.toContain("COPY --from=build /app/dist ./dist");
    expect(dockerfile).not.toContain("COPY --from=build /app/prompts ./prompts");
    expect(dockerfile).not.toContain("COPY --from=build /app/schemas ./schemas");
  });

  it("publishes prereleases from dev and stable releases from main", () => {
    const workflow = readWorkflow(".github/workflows/release.yml");
    const content = readFileSync(".github/workflows/release.yml", "utf8");

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
    expect(content).toContain("required_ref=refs/heads/dev");
    expect(content).toContain("prerelease=false");
    expect(content).toContain("required_ref=refs/heads/main");
    expect(content).toContain("Stable releases must run from main; prereleases must run from dev.");
    expect(content).toContain("collaborators/$REQUEST_ACTOR/permission");
    expect(content).toContain('permission" != "admin"');
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
  });
});

/** @param {string} file */
function readWorkflow(file) {
  return parse(readFileSync(file, "utf8"));
}
