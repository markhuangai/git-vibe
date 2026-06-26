import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { isMap, isScalar, parseDocument, YAMLMap } from "yaml";
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
  ".github/workflows/investigate.yml",
  ".github/workflows/materialize.yml",
  ".github/workflows/review.yml",
  ".github/workflows/validate.yml",
  ".git-vibe/role-group/correctness.md",
  ".git-vibe/role-group/maintainability.md",
  ".git-vibe/role-group/security.md",
];

const requiredWorkflowSourcePaths = requiredInstallSourcePaths.filter(isWorkflowSourcePath);
const requiredUpdateSourcePaths = [".github/git-vibe.yml", ...requiredWorkflowSourcePaths];
const managedWorkflowMarker = "# GitVibe managed workflow wrapper";

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

export function buildUpdateFiles(options: {
  cwd: string;
  releaseTag: string;
  sourceFiles: ConsumerStarterFile[];
}): InstallFile[] {
  requireSourcePaths(options.sourceFiles, requiredUpdateSourcePaths, options.releaseTag);
  return options.sourceFiles
    .filter((file) => isUpdateSourcePath(file.relativePath))
    .map((file) => buildUpdateFile(file, options.cwd, options.releaseTag));
}

export function blockingInstallPaths(files: InstallFile[]): string[] {
  return files
    .map((file) => file.targetPath)
    .filter((targetPath) => existsSync(targetPath))
    .sort();
}

export function unmanagedWorkflowUpdatePaths(files: InstallFile[]): string[] {
  return files
    .filter(isWorkflowInstallFile)
    .filter((file) => existsSync(file.targetPath) && !isManagedWorkflowTarget(file))
    .map((file) => file.targetPath)
    .sort();
}

export function obsoleteWorkflowCleanupPaths(files: InstallFile[]): string[] {
  return obsoleteWorkflowPaths(files)
    .filter((targetPath) => !isMarkedManagedWorkflowFile(targetPath, basename(targetPath)))
    .filter((targetPath) => isManagedWorkflowFile(targetPath, basename(targetPath)))
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
    for (const targetPath of obsoleteManagedWorkflowPaths(files)) {
      snapshots.push(snapshotFile(targetPath));
      rmSync(targetPath, { force: true });
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

export function migrateGitVibeConfigContent(content: string): string {
  const migratedComments = migrateLegacyEventDeliveryComments(content);
  const migratedAuth = migrateGithubAuthConfig(migratedComments);
  const migratedSafety = migratePromptInjectionSafetyConfig(migratedAuth);
  return ensureTrailingNewline(migrateLegacyAiProfiles(migratedSafety));
}

function isManagedWorkflowTarget(file: InstallFile): boolean {
  return isManagedWorkflowFile(file.targetPath, basename(file.targetPath));
}

function isManagedWorkflowFile(targetPath: string, workflowName: string): boolean {
  try {
    return managedWorkflowPattern(workflowName).test(readFileSync(targetPath, "utf8"));
  } catch {
    return false;
  }
}

function obsoleteManagedWorkflowPaths(files: InstallFile[]): string[] {
  return obsoleteWorkflowPaths(files)
    .filter((targetPath) => isMarkedManagedWorkflowFile(targetPath, basename(targetPath)))
    .sort();
}

function obsoleteWorkflowPaths(files: InstallFile[]): string[] {
  const workflowDirectory = dirname(files.find(isWorkflowInstallFile)?.targetPath || "");
  if (!workflowDirectory || workflowDirectory === ".") return [];
  if (!existsSync(workflowDirectory)) return [];
  const currentWorkflowNames = new Set(
    files.filter(isWorkflowInstallFile).map((file) => basename(file.targetPath)),
  );
  return readdirSync(workflowDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !currentWorkflowNames.has(entry.name))
    .map((entry) => join(workflowDirectory, entry.name));
}

function isMarkedManagedWorkflowFile(targetPath: string, workflowName: string): boolean {
  try {
    const content = readFileSync(targetPath, "utf8");
    return (
      content.startsWith(`${managedWorkflowMarker}\n`) &&
      managedWorkflowPattern(workflowName).test(content)
    );
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

function buildUpdateFile(
  sourceFile: ConsumerStarterFile,
  cwd: string,
  releaseTag: string,
): InstallFile {
  const targetPath = join(cwd, safeRelativePath(sourceFile.relativePath));
  const existingContent = fileContentIfExists(targetPath);
  let content = pinWorkflowReleaseRefs(sourceFile.content, releaseTag);

  if (sourceFile.relativePath === ".github/git-vibe.yml" && existingContent !== undefined) {
    content = migrateGitVibeConfigContent(existingContent);
  } else if (isWorkflowSourcePath(sourceFile.relativePath) && existingContent !== undefined) {
    content = preserveWorkflowRunner(content, existingContent);
  }

  return {
    content,
    sourcePath: sourceFile.sourcePath,
    targetPath,
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

function isUpdateSourcePath(relativePath: string): boolean {
  return relativePath === ".github/git-vibe.yml" || isWorkflowSourcePath(relativePath);
}

function isWorkflowSourcePath(relativePath: string): boolean {
  return relativePath.startsWith(".github/workflows/") && relativePath.endsWith(".yml");
}

function isWorkflowInstallFile(file: InstallFile): boolean {
  return file.sourcePath.includes(".github/workflows/") && file.sourcePath.endsWith(".yml");
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

function fileContentIfExists(targetPath: string): string | undefined {
  if (!existsSync(targetPath)) return undefined;
  return readFileSync(targetPath, "utf8");
}

function preserveWorkflowRunner(generatedContent: string, existingContent: string): string {
  const runner = /^\s+runner:\s*(.+)$/m.exec(existingContent)?.[1];
  if (!runner) return generatedContent;
  return generatedContent.replace(/^(\s+runner:\s*).+$/m, `$1${runner}`);
}

function migrateLegacyEventDeliveryComments(content: string): string {
  return content.replace(
    /^event_delivery:\n  # webhook: repository webhook points at the self-hosted GitVibe server\.\n  # relay: webhook proxy\/tunnel such as Smee, Hookdeck, Cloudflare Tunnel, or ngrok\.\n  # actions: no-server receiver workflows in the consumer repository\.\n  # polling: local\/scheduled worker polls GitHub APIs with cursors\/ETags\.\n/m,
    "event_delivery:\n  # Hosted GitHub App installs configure webhooks centrally; repositories do not create hooks.\n",
  );
}

function migrateGithubAuthConfig(content: string): string {
  const githubAppAuth = "github_auth:\n  mode: github-app\n";
  if (/^github_auth:\n/m.test(content)) {
    return content.replace(/^github_auth:\n(?:[ \t]+.*(?:\n|$))*/m, githubAppAuth);
  }
  return `${content.trimEnd()}\n\n${githubAppAuth}`;
}

function migratePromptInjectionSafetyConfig(content: string): string {
  const document = parseDocument(content);
  if (document.errors.length > 0) {
    throw new Error(
      `git-vibe-setup could not migrate .github/git-vibe.yml because it is not valid YAML: ${document.errors[0]?.message}`,
    );
  }

  const root = document.contents;
  if (!isMap(root) || root.has("safety")) return content;

  return `${content.trimEnd()}\n\nsafety:\n  prompt_injection_gate: true\n`;
}

function migrateLegacyAiProfiles(content: string): string {
  const document = parseDocument(content);
  if (document.errors.length > 0) {
    throw new Error(
      `git-vibe-setup could not migrate .github/git-vibe.yml because it is not valid YAML: ${document.errors[0]?.message}`,
    );
  }

  const root = document.contents;
  if (!isMap(root)) return content;
  const ai = root.get("ai", true);
  if (!isMap(ai)) return content;
  const profiles = ai.get("profiles", true);
  if (!isMap(profiles)) return content;

  let changed = false;
  for (const pair of profiles.items) {
    if (isMap(pair.value)) changed = migrateLegacyAiProfile(pair.value) || changed;
  }
  return changed ? document.toString() : content;
}

function migrateLegacyAiProfile(profile: YAMLMap<unknown, unknown>): boolean {
  const adapter = stringNodeValue(profile.get("adapter"));
  if (adapter === "ai-sdk-agentool") {
    migrateAgentoolProfile(profile);
    return true;
  }
  if (adapter === "cli-claude-code") {
    profile.set("adapter", "claude-code-sdk");
    ensureClaudeModel(profile);
    orderProfileKeys(profile);
    return true;
  }
  if (adapter === "cli-codex") {
    profile.set("adapter", "codex-sdk");
    return true;
  }
  return false;
}

function migrateAgentoolProfile(profile: YAMLMap<unknown, unknown>): void {
  const provider = profile.get("provider", true);
  profile.set("adapter", "claude-code-sdk");
  syncClaudeEnvFromProvider(profile, provider);
  syncReasoningEffort(profile);
  trimProviderOptions(profile);
  ensureClaudeModel(profile);
  profile.delete("context_window_tokens");
  profile.delete("provider");
  orderProfileKeys(profile);
}

function syncClaudeEnvFromProvider(profile: YAMLMap<unknown, unknown>, provider: unknown): void {
  const env = ensureMap(profile, "env");
  if (isMap(provider)) {
    copyMapValue(provider, "api_key", env, "ANTHROPIC_API_KEY");
    copyMapValue(provider, "base_url", env, "ANTHROPIC_BASE_URL");
    const providerModel = stringNodeValue(provider.get("model"));
    if (providerModel) {
      setIfMissing(env, "ANTHROPIC_DEFAULT_OPUS_MODEL", providerModel);
      setIfMissing(env, "ANTHROPIC_DEFAULT_SONNET_MODEL", providerModel);
      setIfMissing(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL", providerModel);
    }
  }
  setIfMissing(env, "ANTHROPIC_MODEL", "opus");
  setIfMissing(env, "CLAUDE_CODE_SUBAGENT_MODEL", "opus");
}

function syncReasoningEffort(profile: YAMLMap<unknown, unknown>): void {
  const effort =
    nodeAt(profile, ["reasoning", "effort"]) ||
    nodeAt(profile, ["provider_options", "anthropic", "effort"]);
  if (!effort) return;
  const reasoning = ensureMap(profile, "reasoning");
  if (!reasoning.has("effort")) reasoning.set("effort", effort);
}

function trimProviderOptions(profile: YAMLMap<unknown, unknown>): void {
  const providerOptions = profile.get("provider_options", true);
  if (!isMap(providerOptions)) return;
  providerOptions.delete("openai");
  if (providerOptions.items.length === 0) profile.delete("provider_options");
}

function ensureClaudeModel(profile: YAMLMap<unknown, unknown>): void {
  setIfMissing(profile, "model", "opus");
}

function ensureMap(parent: YAMLMap<unknown, unknown>, key: string): YAMLMap<unknown, unknown> {
  const value = parent.get(key, true);
  if (isMap(value)) return value;
  const map = new YAMLMap();
  parent.set(key, map);
  return map;
}

function copyMapValue(
  source: YAMLMap<unknown, unknown>,
  sourceKey: string,
  target: YAMLMap<unknown, unknown>,
  targetKey: string,
): void {
  if (target.has(targetKey)) return;
  const value = source.get(sourceKey, true);
  if (value !== undefined) target.set(targetKey, value);
}

function setIfMissing(map: YAMLMap<unknown, unknown>, key: string, value: unknown): void {
  if (!map.has(key)) map.set(key, value);
}

function nodeAt(map: YAMLMap<unknown, unknown>, path: string[]): unknown {
  let current: unknown = map;
  for (const segment of path) {
    if (!isMap(current)) return undefined;
    current = current.get(segment, true);
  }
  return current;
}

function stringNodeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isScalar(value) && typeof value.value === "string") return value.value;
  return undefined;
}

function orderProfileKeys(profile: YAMLMap<unknown, unknown>): void {
  const priorities = new Map([
    ["adapter", 0],
    ["env", 1],
    ["model", 2],
    ["reasoning", 3],
    ["provider_options", 4],
  ]);
  profile.items.sort((left, right) => {
    return profileKeyPriority(left, priorities) - profileKeyPriority(right, priorities);
  });
}

function profileKeyPriority(pair: { key: unknown }, priorities: Map<string, number>): number {
  return priorities.get(pairKey(pair)) ?? 100;
}

function pairKey(pair: { key: unknown }): string {
  return stringNodeValue(pair.key) || "";
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
