import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("GitVibe app deployment boundary", () => {
  it("deploys the app only when app, shared, package, or deploy files change", () => {
    const paths = readWorkflow(".github/workflows/app-deploy.yml").on?.push?.paths || [];

    expect(paths).toContain("src/app/**");
    expect(paths).toContain("src/shared/**");
    expect(paths).toContain(".github/workflows/release.yml");
    expect(paths).not.toContain("src/**");
    expect(paths).not.toContain("src/runner/**");
    expect(paths).not.toContain("prompts/**");
    expect(paths).not.toContain("schemas/**");
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

  it("publishes releases only from main by repository admins", () => {
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
    expect(workflow.jobs?.release?.env).toMatchObject({
      BUILDX_CONFIG: "/tmp/.docker-buildx",
      DOCKER_CONTEXT: "default",
    });
    expect(content).toContain('GITHUB_REF" != "refs/heads/main"');
    expect(content).toContain("collaborators/$REQUEST_ACTOR/permission");
    expect(content).toContain('permission" != "admin"');
    expect(content).toContain("docker buildx inspect rootless --bootstrap");
    expect(content).toContain("docker buildx rm rootless");
    expect(content).toContain("docker buildx create --name rootless --use default");
    expect(content).not.toContain("docker/login-action");
    expect(content).toContain("docker pull");
    expect(content).toContain("docker push");
    expect(content).toContain("docker image rm");
    expect(content).toContain("docker buildx prune --force --filter until=48h");
    expect(content).toContain("gh release create");
    expect(content).toContain("--generate-notes");
  });
});

/** @param {string} file */
function readWorkflow(file) {
  return parse(readFileSync(file, "utf8"));
}
