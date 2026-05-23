import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, win32 } from "node:path";

export function systemWithProfileContext(options: {
  cwd: string;
  profile: Record<string, unknown>;
  profileName: string;
  system: string;
}): string {
  const addition = profileContextSystemAddition(options);
  return addition ? `${options.system}\n\n${addition}` : options.system;
}

export function profileContextSystemAddition(options: {
  cwd: string;
  profile: Record<string, unknown>;
  profileName: string;
}): string | null {
  const files = profileContextFiles(options.profile, `ai.profiles.${options.profileName}.context`);
  if (files.length === 0) return null;
  return files
    .map((file, index) =>
      profileContextBlock({
        content: readProfileContextFile({
          cwd: options.cwd,
          path: file,
          sourcePath: `ai.profiles.${options.profileName}.context.files[${index}]`,
        }),
        path: file,
        profileName: options.profileName,
      }),
    )
    .join("\n\n");
}

function profileContextFiles(profile: Record<string, unknown>, sourcePath: string): string[] {
  const context = profile.context;
  if (context === undefined) return [];
  if (!isRecord(context)) throw new Error(`${sourcePath} must be an object.`);

  const files = context.files;
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${sourcePath}.files must be a non-empty string array.`);
  }

  return files.map((file, index) => {
    const value = stringValue(file);
    if (!value) throw new Error(`${sourcePath}.files[${index}] must be a non-empty string.`);
    assertRelativeWorkspacePath(value, `${sourcePath}.files[${index}]`);
    return value;
  });
}

function readProfileContextFile(options: {
  cwd: string;
  path: string;
  sourcePath: string;
}): string {
  const filePath = join(options.cwd, options.path);
  let fileInfo: ReturnType<typeof lstatSync>;
  try {
    fileInfo = lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `Profile context file does not exist: ${options.sourcePath} (${options.path})`,
      );
    }
    throw error;
  }

  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error(`Profile context file must be a regular file: ${options.path}`);
  }

  const realCwd = realpathSync(options.cwd);
  const realFilePath = realpathSync(filePath);
  if (!isPathInside(realFilePath, realCwd)) {
    throw new Error(`Profile context file must stay inside the workspace: ${options.path}`);
  }

  const content = readFileSync(filePath, "utf8").trim();
  if (!content) throw new Error(`Profile context file must not be empty: ${options.path}`);
  return content;
}

function profileContextBlock(options: {
  content: string;
  path: string;
  profileName: string;
}): string {
  return `<git_vibe_profile_context profile="${xmlAttribute(options.profileName)}" path="${xmlAttribute(
    options.path,
  )}">
${options.content}
</git_vibe_profile_context>`;
}

function assertRelativeWorkspacePath(value: string, sourcePath: string): void {
  const segments = value.split(/[\\/]+/);
  if (value === "." || isAbsolute(value) || win32.isAbsolute(value) || segments.includes("..")) {
    throw new Error(`${sourcePath} must be a relative path inside the workspace.`);
  }
}

function isPathInside(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, filePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function xmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
