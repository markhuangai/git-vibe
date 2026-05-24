import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { ConsumerStarterFile } from "./consumer-starter.js";

export interface InstallFile {
  content: string;
  sourcePath: string;
  targetPath: string;
}

interface FileSnapshot {
  content?: string;
  existed: boolean;
  targetPath: string;
}

const requiredInstallSourcePaths = [
  ".github/git-vibe.yml",
  ".github/workflows/address-feedback.yml",
  ".github/workflows/develop.yml",
  ".github/workflows/investigate.yml",
  ".github/workflows/materialize.yml",
  ".github/workflows/review.yml",
  ".github/workflows/validate.yml",
  ".git-vibe/role-group/correctness.md",
  ".git-vibe/role-group/maintainability.md",
  ".git-vibe/role-group/security.md",
];

const requiredWorkflowSourcePaths = requiredInstallSourcePaths.filter(isWorkflowSourcePath);

export function buildInstallFiles(options: {
  cwd: string;
  releaseTag: string;
  sourceFiles: ConsumerStarterFile[];
}): InstallFile[] {
  requireSourcePaths(options.sourceFiles, requiredInstallSourcePaths, options.releaseTag);
  return options.sourceFiles
    .filter((file) => isInstallSourcePath(file.relativePath))
    .map((file) => buildInstallFile(file, options.cwd, options.releaseTag));
}

export function buildWorkflowUpdateFiles(options: {
  cwd: string;
  releaseTag: string;
  sourceFiles: ConsumerStarterFile[];
}): InstallFile[] {
  requireSourcePaths(options.sourceFiles, requiredWorkflowSourcePaths, options.releaseTag);
  return options.sourceFiles
    .filter((file) => isWorkflowSourcePath(file.relativePath))
    .map((file) => buildInstallFile(file, options.cwd, options.releaseTag));
}

export function blockingInstallPaths(files: InstallFile[]): string[] {
  return files
    .map((file) => file.targetPath)
    .filter((targetPath) => existsSync(targetPath))
    .sort();
}

export function unmanagedWorkflowUpdatePaths(files: InstallFile[]): string[] {
  return files
    .filter((file) => existsSync(file.targetPath) && !isManagedWorkflowTarget(file))
    .map((file) => file.targetPath)
    .sort();
}

export function installFiles(files: InstallFile[]): void {
  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];

  try {
    for (const file of files) {
      ensureDirectory(dirname(file.targetPath), createdDirectories);
      writeFileSync(file.targetPath, file.content, { flag: "wx" });
      createdFiles.push(file.targetPath);
    }
  } catch (error) {
    rollbackInstall(createdFiles, createdDirectories);
    throw error;
  }
}

export function updateFiles(files: InstallFile[]): void {
  const createdDirectories: string[] = [];
  const snapshots: FileSnapshot[] = [];

  try {
    for (const file of files) {
      ensureDirectory(dirname(file.targetPath), createdDirectories);
      snapshots.push(snapshotFile(file.targetPath));
      writeFileSync(file.targetPath, file.content);
    }
  } catch (error) {
    rollbackUpdate(snapshots, createdDirectories);
    throw error;
  }
}

export function existingFilesError(paths: string[], cwd: string): Error {
  const listed = paths.map((path) => `- ${relative(cwd, path) || path}`).join("\n");
  return new Error(
    `git-vibe-setup found existing GitVibe files and did not overwrite them:\n${listed}\nRemove the listed files before running setup again.`,
  );
}

export function unmanagedWorkflowUpdateError(paths: string[], cwd: string): Error {
  const listed = paths.map((path) => `- ${relative(cwd, path) || path}`).join("\n");
  return new Error(
    `git-vibe-setup found workflow files that do not look like GitVibe wrappers and did not overwrite them:\n${listed}`,
  );
}

export function pinWorkflowReleaseRefs(content: string, releaseTag: string): string {
  return content.replace(
    /(uses:\s*markhuangai\/git-vibe\/\.github\/workflows\/[^\s@]+)@[^\s]+/g,
    (_match, workflowReference) => `${workflowReference}@${releaseTag}`,
  );
}

function isManagedWorkflowTarget(file: InstallFile): boolean {
  try {
    const workflowName = basename(file.targetPath);
    return managedWorkflowPattern(workflowName).test(readFileSync(file.targetPath, "utf8"));
  } catch {
    return false;
  }
}

function managedWorkflowPattern(workflowName: string): RegExp {
  return new RegExp(
    `uses:\\s*markhuangai/git-vibe/\\.github/workflows/${escapeRegExp(workflowName)}@`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function snapshotFile(targetPath: string): FileSnapshot {
  if (!existsSync(targetPath)) return { existed: false, targetPath };
  return {
    content: readFileSync(targetPath, "utf8"),
    existed: true,
    targetPath,
  };
}

function ensureDirectory(directory: string, createdDirectories: string[]): void {
  const missing = missingDirectories(directory);
  for (const path of missing) {
    mkdirSync(path);
    createdDirectories.push(path);
  }
}

function missingDirectories(directory: string): string[] {
  const missing: string[] = [];
  let current = directory;

  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    /* c8 ignore next */
    if (parent === current) break;
    current = parent;
  }

  return missing.reverse();
}

function rollbackUpdate(snapshots: FileSnapshot[], createdDirectories: string[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.existed) {
      writeFileSync(snapshot.targetPath, snapshot.content || "");
    } else {
      rmSync(snapshot.targetPath, { force: true });
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    rmSync(directory, { force: true, recursive: false });
  }
}

function rollbackInstall(createdFiles: string[], createdDirectories: string[]): void {
  for (const file of [...createdFiles].reverse()) {
    rmSync(file, { force: true });
  }
  for (const directory of [...createdDirectories].reverse()) {
    rmSync(directory, { force: true, recursive: false });
  }
}

function buildInstallFile(
  sourceFile: ConsumerStarterFile,
  cwd: string,
  releaseTag: string,
): InstallFile {
  return {
    content: pinWorkflowReleaseRefs(sourceFile.content, releaseTag),
    sourcePath: sourceFile.sourcePath,
    targetPath: join(cwd, safeRelativePath(sourceFile.relativePath)),
  };
}

function requireSourcePaths(
  sourceFiles: ConsumerStarterFile[],
  requiredPaths: string[],
  releaseTag: string,
): void {
  const sourcePaths = new Set(sourceFiles.map((file) => file.relativePath));
  const missingPaths = requiredPaths.filter((path) => !sourcePaths.has(path));

  if (missingPaths.length === 0) return;

  const listed = missingPaths.map((path) => `- examples/consumer/${path}`).join("\n");
  throw new Error(
    `git-vibe-setup found an incomplete GitVibe consumer starter at markhuangai/git-vibe@${releaseTag}. Missing files:\n${listed}\nNo files were written.`,
  );
}

function isInstallSourcePath(relativePath: string): boolean {
  return relativePath.startsWith(".github/") || relativePath.startsWith(".git-vibe/");
}

function isWorkflowSourcePath(relativePath: string): boolean {
  return relativePath.startsWith(".github/workflows/") && relativePath.endsWith(".yml");
}

function safeRelativePath(relativePath: string): string {
  const segments = relativePath.split("/");
  const isSafe =
    relativePath.length > 0 &&
    !relativePath.startsWith("/") &&
    !relativePath.includes("\\") &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  if (isSafe) return relativePath;

  throw new Error(`git-vibe-setup found an unsafe starter file path: ${relativePath}`);
}
