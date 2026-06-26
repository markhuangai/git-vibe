import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  PackedPromptContextFiles,
  PromptContextFileReference,
  PromptContextUnitFile,
} from "./content-units.js";
import { contentUnitsForContext } from "./content-units.js";
import { contextWithoutIgnoredAuthors } from "./ignored-authors.js";
import type { ContextPacket, JsonObject } from "../shared/types.js";

export function writePromptContextFiles(options: {
  context: ContextPacket;
  ignoredAuthors?: readonly string[];
  rootDir: string;
  stage: string;
}): PackedPromptContextFiles {
  const rootDir = join(options.rootDir, `git-vibe-${options.stage}-context-files`);
  const unitsDir = join(rootDir, "units");
  mkdirSync(unitsDir, { recursive: true });
  const context = contextWithoutIgnoredAuthors(options.context, options.ignoredAuthors);

  const fullContext = writeJsonReference({
    content: context,
    path: join(rootDir, "github-context.json"),
    rootDir,
  });
  const units = contentUnitsForContext(context).map((unit, index) => {
    const path = join(unitsDir, unitFilename(unit.id, index));
    writeFileSync(path, unit.text);
    return {
      chars: unit.text.length,
      id: unit.id,
      kind: unit.kind,
      label: unit.label,
      metadata: unit.metadata,
      path,
      path_in_repository: unit.path,
      relative_path: relative(rootDir, path),
      sha256: sha256(unit.text),
      sourceUrl: unit.sourceUrl,
    } satisfies PromptContextUnitFile;
  });
  const manifestContent = {
    full_context: fullContext,
    generatedAt: options.context.generatedAt,
    repository: options.context.repository,
    total_units: units.length,
    units,
  };
  const manifest = writeJsonReference({
    content: manifestContent,
    path: join(rootDir, "manifest.json"),
    rootDir,
  });

  return {
    full_context: fullContext,
    manifest,
    root_dir: rootDir,
    units,
    units_dir: unitsDir,
  };
}

function writeJsonReference(options: {
  content: JsonObject | ContextPacket;
  path: string;
  rootDir: string;
}): PromptContextFileReference {
  const text = `${JSON.stringify(options.content, null, 2)}\n`;
  writeFileSync(options.path, text);
  return {
    chars: text.length,
    path: options.path,
    relative_path: relative(options.rootDir, options.path),
    sha256: sha256(text),
  };
}

function unitFilename(unitId: string, index: number): string {
  const safe = unitId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${String(index + 1).padStart(4, "0")}-${safe}-${sha256(unitId).slice(0, 12)}.txt`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
