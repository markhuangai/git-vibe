import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ContextPacket, JsonObject } from "../shared/types.js";

export interface RenderPromptOptions {
  context: ContextPacket;
  cwd?: string;
  outputSchema: JsonObject;
  promptDir: string;
  repositoryContext: string;
  roleDefinition?: string;
  stageContract: string;
}

export function renderPrompts(options: RenderPromptOptions): { prompt: string; system: string } {
  const sharedDir = join(assetRoot(), "prompts", "_shared");
  const dir = join(assetRoot(), "prompts", options.promptDir);
  const systemParts = [
    readFileSync(join(sharedDir, "system.md"), "utf8").trim(),
    readFileSync(join(dir, "system.md"), "utf8").trim(),
  ];
  const userParts = [
    readFileSync(join(sharedDir, "user.md"), "utf8").trim(),
    readFileSync(join(dir, "user.md"), "utf8").trim(),
  ];

  const repoSystemAddition = readRepoPromptAddition(options.cwd, options.promptDir, "system.md");
  if (repoSystemAddition) systemParts.push(repoSystemAddition);
  if (options.roleDefinition) {
    systemParts.push(`<git_vibe_role_definition>
${options.roleDefinition}
</git_vibe_role_definition>`);
  }

  const repoUserAddition = readRepoPromptAddition(options.cwd, options.promptDir, "user.md");
  if (repoUserAddition) userParts.push(repoUserAddition);

  const system = systemParts.join("\n\n");
  const userTemplate = userParts.join("\n\n");
  const prompt = userTemplate
    .replace("{{github_context}}", xmlJson("github_context", options.context))
    .replace("{{repository_context}}", xmlText("repository_context", options.repositoryContext))
    .replace("{{stage_contract}}", xmlText("stage_contract", options.stageContract))
    .replace("{{output_schema}}", xmlJson("output_schema", options.outputSchema));

  return { prompt, system };
}

function xmlJson(name: string, value: unknown): string {
  return `<${name}>\n${JSON.stringify(value, null, 2)}\n</${name}>`;
}

function xmlText(name: string, value: string): string {
  return `<${name}>\n${value}\n</${name}>`;
}

function assetRoot(): string {
  return (
    process.env.GITVIBE_ASSET_ROOT ||
    (process.env.GITHUB_ACTION_PATH ? dirname(process.env.GITHUB_ACTION_PATH) : process.cwd())
  );
}

function readRepoPromptAddition(
  cwd: string | undefined,
  promptDir: string,
  filename: string,
): string | null {
  if (!cwd) return null;
  const filePath = join(cwd, ".git-vibe", "prompts", promptDir, filename);
  try {
    assertRepoPromptPath(cwd, filePath);
    const content = readFileSync(filePath, "utf8").trim();
    if (!content) return null;
    return `<repository_prompt_addition>
${content}
</repository_prompt_addition>`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function assertRepoPromptPath(cwd: string, filePath: string): void {
  const fileInfo = lstatSync(filePath);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error(`Repository prompt addition must be a regular file: ${filePath}`);
  }

  const realCwd = realpathSync(cwd);
  const realFilePath = realpathSync(filePath);
  if (!isPathInside(realFilePath, realCwd)) {
    throw new Error(`Repository prompt addition must stay inside the workspace: ${filePath}`);
  }
}

function isPathInside(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, filePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}
