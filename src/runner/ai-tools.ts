import { createAgent } from "agentool/agent";
import { createBash } from "agentool/bash";
import { createDiff } from "agentool/diff";
import { createEdit } from "agentool/edit";
import { createGlob } from "agentool/glob";
import { createGrep } from "agentool/grep";
import { createMultiEdit } from "agentool/multi-edit";
import { createOutputValidator } from "agentool/output-validator";
import { createRead } from "agentool/read";
import { createWrite } from "agentool/write";
import type { LanguageModel, ToolSet } from "ai";
import type { Stage } from "../shared/types.js";
import { stageConfigFor, stringValue } from "./ai-config.js";
import { filterToolsForWebPolicy, webPolicyFor, webPolicySystemPrompt } from "./ai-web-policy.js";
import { createWebFetch, createWebSearch } from "./ai-web-tools.js";
import { createGitHubSearch } from "./github-search.js";
import type { RunAiStageOptions } from "./ai.js";

type WebPolicy = ReturnType<typeof webPolicyFor>;

export function createTools(
  options: RunAiStageOptions,
  model: LanguageModel,
  toolNamesForStage: string[],
): ToolSet {
  const webPolicy = webPolicyFor(options.config);
  const tools: ToolSet = {
    output_validator: createOutputValidator({
      schema: options.schema as never,
      schemaId: options.schemaId,
    }),
  };

  for (const toolName of toolNamesForStage) {
    addStageTool({
      model,
      options,
      stageToolNames: toolNamesForStage,
      toolName,
      tools,
      webPolicy,
    });
  }

  return tools;
}

export function stageToolNames(options: RunAiStageOptions): string[] {
  if (options.toolOverride) {
    const disallowed = options.toolOverride.filter((tool) => !toolAllowedForStage(tool, options));
    if (disallowed.length > 0) {
      throw new Error(
        `AI tool override for ${options.stage} includes disallowed tools: ${disallowed.join(", ")}.`,
      );
    }
    return filterToolsForWebPolicy({
      config: options.config,
      explicit: true,
      logger: options.logger,
      stage: options.stage,
      tools: options.toolOverride,
    });
  }

  const configuredTools = stageConfigFor(options.config, options.stage).tools;
  if (configuredTools === undefined) {
    return filterToolsForWebPolicy({
      config: options.config,
      explicit: false,
      logger: options.logger,
      stage: options.stage,
      tools: options.stageDefinition.tools,
    });
  }
  if (!Array.isArray(configuredTools) || configuredTools.some((tool) => !stringValue(tool))) {
    throw new Error(`ai.stages.${options.stage}.tools must be a string array.`);
  }

  const tools = configuredTools as string[];
  const disallowed = tools.filter((tool) => !options.stageDefinition.tools.includes(tool));
  if (disallowed.length > 0) {
    throw new Error(
      `ai.stages.${options.stage}.tools includes disallowed tools: ${disallowed.join(", ")}.`,
    );
  }

  return filterToolsForWebPolicy({
    config: options.config,
    explicit: true,
    logger: options.logger,
    stage: options.stage,
    tools,
  });
}

function addStageTool(options: {
  model?: LanguageModel;
  options: RunAiStageOptions;
  stageToolNames: string[];
  toolName: string;
  tools: ToolSet;
  webPolicy: WebPolicy;
}): void {
  const cwd = options.options.cwd;
  if (options.toolName === "read") options.tools.read = createRead({ cwd });
  if (options.toolName === "grep") options.tools.grep = createGrep({ cwd });
  if (options.toolName === "glob") options.tools.glob = createGlob({ cwd });
  if (options.toolName === "bash-readonly")
    options.tools.bash = createBash({ cwd, description: "Read-only shell commands only." });
  if (options.toolName === "bash") options.tools.bash = createBash({ cwd });
  if (options.toolName === "diff") options.tools.diff = createDiff({ cwd });
  if (options.toolName === "edit") options.tools.edit = createEdit({ cwd });
  if (options.toolName === "write") options.tools.write = createWrite({ cwd });
  if (options.toolName === "multi-edit") options.tools.multi_edit = createMultiEdit({ cwd });
  if (options.toolName === "github-search")
    options.tools.github_search = createGitHubSearch(options.options);
  if (options.toolName === "web-fetch") options.tools.web_fetch = createWebFetch();
  if (options.toolName === "web-search") options.tools.web_search = createWebSearch();
  if (options.toolName === "agent")
    options.tools.agent = createReadOnlyAgentTool({
      model: requiredAgentModel(options.model),
      options: options.options,
      stageToolNames: options.stageToolNames,
      webPolicy: options.webPolicy,
    });
}

function requiredAgentModel(model: LanguageModel | undefined): LanguageModel {
  if (!model) throw new Error("agent tool requires an AI SDK model.");
  return model;
}

function createReadOnlyAgentTool(options: {
  model: LanguageModel;
  options: RunAiStageOptions;
  stageToolNames: string[];
  webPolicy: WebPolicy;
}) {
  return createAgent({
    agents: readOnlyAgentDefinitions(options.options.stage),
    defaultAgent: "code",
    defaultTimeoutMs: 10 * 60 * 1000,
    defaultWaitTimeoutMs: 10 * 60 * 1000,
    description: readOnlyAgentDescription(options.options.stage),
    maxConcurrent: 3,
    maxResultChars: 20_000,
    maxTurns: 12,
    model: options.model,
    tools: createReadOnlyAgentTools({
      options: options.options,
      stageToolNames: options.stageToolNames,
      webPolicy: options.webPolicy,
    }),
  });
}

function createReadOnlyAgentTools(options: {
  options: RunAiStageOptions;
  stageToolNames: string[];
  webPolicy: WebPolicy;
}): ToolSet {
  const tools: ToolSet = {};
  for (const toolName of options.stageToolNames) {
    if (!readOnlyAgentToolAllowed(toolName)) continue;
    addStageTool({
      options: options.options,
      stageToolNames: options.stageToolNames,
      toolName,
      tools,
      webPolicy: options.webPolicy,
    });
  }
  return tools;
}

function readOnlyAgentToolAllowed(toolName: string): boolean {
  return ["read", "grep", "glob", "diff", "github-search", "web-fetch", "web-search"].includes(
    toolName,
  );
}

function readOnlyAgentDefinitions(stage: Stage) {
  return {
    code: {
      description: "Trace relevant source code and configuration.",
      systemPrompt: readOnlyAgentSystemPrompt(stage, [
        "Focus on source paths, existing behavior, local patterns, and concrete file references.",
        "Do not propose code edits unless the orchestrator explicitly asks for investigation output.",
      ]),
    },
    security: {
      description: "Look for permission, token, injection, and data exposure risks.",
      systemPrompt: readOnlyAgentSystemPrompt(stage, [
        "Focus on GitHub permissions, credentials, untrusted input, command execution, and log/artifact exposure.",
        "Report only evidence-backed risks with file or prompt references.",
      ]),
    },
    tests: {
      description: "Inspect tests, coverage expectations, and validation gaps.",
      systemPrompt: readOnlyAgentSystemPrompt(stage, [
        "Focus on existing test coverage, missing regression cases, and contract-test needs.",
        "Prefer real behavior tests over mocked implementation details.",
      ]),
    },
  };
}

function readOnlyAgentDescription(stage: Stage): string {
  return [
    `Spawn GitVibe-controlled read-only subagents for the ${stage} stage.`,
    "Use this when independent repository investigations can run in parallel.",
    "Subagents do not receive the parent prompt or messages; include the issue or PR context, relevant file paths, constraints, and exact question in each subagent prompt.",
    "Subagents receive only read-only tools and must report findings for the orchestrator to synthesize into the final schema output.",
  ].join("\n\n");
}

function readOnlyAgentSystemPrompt(stage: Stage, focus: string[]): string {
  return [
    `You are a GitVibe read-only subagent for the ${stage} stage.`,
    "You may inspect repository and GitHub context only through the tools provided to you.",
    "Do not edit files, create branches, run write commands, publish comments, change labels, or perform GitHub writes.",
    "Do not produce the final GitVibe stage JSON. Return concise investigation notes for the orchestrator.",
    "Cite concrete files, lines, prompts, schemas, or GitHub context when available.",
    "If evidence is missing, state what is missing instead of guessing.",
    webPolicySystemPrompt(),
    ...focus,
  ].join("\n");
}

function toolAllowedForStage(tool: string, options: RunAiStageOptions): boolean {
  if (options.stageDefinition.tools.includes(tool)) return true;
  return tool === "bash-readonly" && options.stageDefinition.tools.includes("bash");
}
