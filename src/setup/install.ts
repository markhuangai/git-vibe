import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface InstallFile {
  content: string;
  sourcePath: string;
  targetPath: string;
}

interface InstallSource {
  sourceDirectory: string;
  targetDirectory: string;
}

export function buildInstallFiles(options: {
  cwd: string;
  releaseTag: string;
  repositoryRoot: string;
}): InstallFile[] {
  return installSources(options.repositoryRoot).flatMap((source) =>
    listRelativeFiles(source.sourceDirectory).map((relativePath) => {
      const sourcePath = join(source.sourceDirectory, relativePath);
      const targetPath = join(options.cwd, source.targetDirectory, relativePath);
      const content = readFileSync(sourcePath, "utf8");

      return {
        content: pinWorkflowReleaseRefs(content, options.releaseTag),
        sourcePath,
        targetPath,
      };
    }),
  );
}

export function blockingInstallPaths(files: InstallFile[]): string[] {
  return files
    .map((file) => file.targetPath)
    .filter((targetPath) => existsSync(targetPath))
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

export function existingFilesError(paths: string[], cwd: string): Error {
  const listed = paths.map((path) => `- ${relative(cwd, path) || path}`).join("\n");
  return new Error(
    `git-vibe-setup found existing GitVibe files and did not overwrite them:\n${listed}\nRemove the listed files before running setup again.`,
  );
}

export function pinWorkflowReleaseRefs(content: string, releaseTag: string): string {
  return content.replace(
    /(uses:\s*markhuangai\/git-vibe\/\.github\/workflows\/[^\s@]+)@[^\s]+/g,
    (_match, workflowReference) => `${workflowReference}@${releaseTag}`,
  );
}

function installSources(repositoryRoot: string): InstallSource[] {
  return [
    {
      sourceDirectory: join(repositoryRoot, "examples", "consumer", ".github"),
      targetDirectory: ".github",
    },
    {
      sourceDirectory: join(repositoryRoot, "examples", "consumer", ".git-vibe"),
      targetDirectory: ".git-vibe",
    },
  ];
}

function listRelativeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return listRelativeFiles(entryPath).map((path) => join(entry.name, path));
      }
      /* c8 ignore next */
      return entry.isFile() ? [entry.name] : [];
    })
    .sort();
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

function rollbackInstall(createdFiles: string[], createdDirectories: string[]): void {
  for (const file of [...createdFiles].reverse()) {
    rmSync(file, { force: true });
  }
  for (const directory of [...createdDirectories].reverse()) {
    rmSync(directory, { force: true, recursive: false });
  }
}
