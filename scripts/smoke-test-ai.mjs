#!/usr/bin/env node

import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { createOutputValidator } from "agentool/output-validator";
import { createRead } from "agentool/read";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ error(message: string): void, log(message: string): void }} Logger
 * @typedef {{ apiKey: string, baseUrl: string, cwd: string, maxOutputTokens: number, maxSteps: number, model: string, requireTool: boolean }} SmokeConfig
 * @typedef {{ observedAgentoolSpecifier: string, ok: boolean, packageName: string, source: "local-proxy", summary: string }} SmokeOutput
 * @typedef {{ input?: unknown, toolName?: string }} SmokeToolCall
 * @typedef {{ toolCalls: SmokeToolCall[] }} SmokeStep
 * @typedef {{ steps: SmokeStep[], text: string }} SmokeResult
 * @typedef {{ model: string, observedAgentoolSpecifier: string, packageName: string, toolCallCount: number, toolEvents: string[] }} SmokeReport
 * @typedef {{ createOpenAI(options: { apiKey: string, baseURL: string, name: string }): { chat(model: string): unknown }, createOutputValidator(options: Record<string, unknown>): unknown, createRead(options: { cwd: string }): unknown, generateText(options: Record<string, unknown>): Promise<SmokeResult>, stepCountIs(stepCount: number): unknown }} SmokeDependencies
 */

const resultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "source", "packageName", "observedAgentoolSpecifier", "summary"],
  properties: {
    ok: { type: "boolean" },
    source: { enum: ["local-proxy"] },
    packageName: { type: "string" },
    observedAgentoolSpecifier: { type: "string" },
    summary: { type: "string" },
  },
};

const resultSchema = z.object({
  ok: z.boolean(),
  source: z.literal("local-proxy"),
  packageName: z.string(),
  observedAgentoolSpecifier: z.string(),
  summary: z.string(),
});

/** @type {SmokeDependencies} */
const defaultDependencies = {
  createOpenAI,
  createOutputValidator,
  createRead,
  generateText,
  stepCountIs,
};

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = await main();
}

/**
 * @param {{ env?: Env, cwd?: string, workspace?: string | undefined, logger?: Logger, dependencies?: SmokeDependencies }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  env = process.env,
  cwd = process.cwd(),
  workspace = process.env.GITHUB_WORKSPACE,
  logger = console,
  dependencies = defaultDependencies,
} = {}) {
  try {
    const report = await runSmokeTest({ env, cwd, workspace, dependencies });
    logReport(report, logger);
    return 0;
  } catch (error) {
    logger.error(`[git-vibe] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * @param {{ env: Env, cwd: string, workspace?: string | undefined, dependencies?: SmokeDependencies }} options
 * @returns {Promise<SmokeReport>}
 */
export async function runSmokeTest({ env, cwd, workspace, dependencies = defaultDependencies }) {
  const config = readConfig({ env, cwd, workspace });
  const model = dependencies
    .createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      name: "git-vibe-local-proxy",
    })
    .chat(config.model);
  /** @type {string[]} */
  const toolEvents = [];
  const result = await dependencies.generateText(
    buildGenerationOptions({ config, dependencies, model, toolEvents }),
  );
  const output = parseSmokeOutput(outputContent(result, config));
  const toolCallCount = countToolCalls(result);
  const readToolCallCount = countToolCallsByName(result, "read");
  const outputValidatorCallCount = countToolCallsByName(result, "output_validator");

  validateOutput({ config, output, outputValidatorCallCount, readToolCallCount });

  return {
    model: config.model,
    observedAgentoolSpecifier: output.observedAgentoolSpecifier,
    packageName: output.packageName,
    toolCallCount,
    toolEvents,
  };
}

/**
 * @param {{ env: Env, cwd: string, workspace?: string | undefined }} options
 * @returns {SmokeConfig}
 */
export function readConfig({ env, cwd, workspace }) {
  return {
    apiKey: requiredEnv(env, "GITVIBE_AI_API_KEY"),
    baseUrl: requiredEnv(env, "GITVIBE_AI_BASE_URL"),
    model: requiredEnv(env, "GITVIBE_AI_MODEL"),
    cwd: workspace || cwd,
    maxOutputTokens: numberEnv(env, "GITVIBE_AI_MAX_OUTPUT_TOKENS", 1000),
    maxSteps: numberEnv(env, "GITVIBE_AI_SMOKE_MAX_STEPS", 4),
    requireTool: booleanEnv(env, "GITVIBE_AI_SMOKE_REQUIRE_TOOL", true),
  };
}

/**
 * @param {{ config: SmokeConfig, dependencies: SmokeDependencies, model: unknown, toolEvents: string[] }} options
 * @returns {Record<string, unknown>}
 */
export function buildGenerationOptions({ config, dependencies, model, toolEvents }) {
  return {
    model,
    tools: config.requireTool
      ? {
          output_validator: dependencies.createOutputValidator({
            schema: resultJsonSchema,
            schemaId: "git-vibe-smoke.v1",
          }),
          read: dependencies.createRead({ cwd: config.cwd }),
        }
      : undefined,
    stopWhen: dependencies.stepCountIs(config.maxSteps),
    temperature: 0,
    maxOutputTokens: config.maxOutputTokens,
    maxRetries: 0,
    system: [
      "You are running a GitVibe smoke test.",
      "Return only one JSON object with no Markdown fences.",
      "When tools are available, call output_validator with the exact final JSON before answering.",
      "Do not modify files or call write-capable tools.",
    ].join(" "),
    prompt: buildPrompt(config.requireTool),
    experimental_onToolCallStart: (
      /** @type {{ toolCall?: { toolName?: unknown } } | undefined} */ event,
    ) => {
      const toolName = event?.toolCall?.toolName;
      toolEvents.push(typeof toolName === "string" ? toolName : "<unknown>");
    },
  };
}

/**
 * @param {boolean} requireTool
 * @returns {string}
 */
export function buildPrompt(requireTool) {
  const toolInstruction = requireTool
    ? "Use the read tool to inspect package.json before answering. Draft the final JSON, call output_validator with content set to that exact JSON string, then return the same JSON."
    : "You may answer without tools if tool calling is not available.";

  return [
    toolInstruction,
    'Return exactly this JSON shape: {"ok":true,"source":"local-proxy","packageName":"...","observedAgentoolSpecifier":"...","summary":"..."}.',
    "Report whether this repo is named git-vibe and what package.json declares for agentool.",
    "Set ok to true if the request can be answered.",
  ].join(" ");
}

/**
 * @param {SmokeResult} result
 * @param {Pick<SmokeConfig, "requireTool">} config
 * @returns {string}
 */
export function outputContent(result, config) {
  const toolContent = outputValidatorContent(result);
  if (toolContent) {
    return toolContent;
  }

  if (config.requireTool) {
    throw new Error("local proxy completed, but the model did not call output_validator.");
  }

  return result.text;
}

/**
 * @param {SmokeResult} result
 * @returns {string | undefined}
 */
export function outputValidatorContent(result) {
  const calls = allToolCalls(result);
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call.toolName !== "output_validator") continue;

    const input = call.input;
    if (!input || typeof input !== "object") continue;

    const content = /** @type {Record<string, unknown>} */ (input).content;
    if (typeof content === "string") {
      return content;
    }
  }

  return undefined;
}

/**
 * @param {string} text
 * @returns {SmokeOutput}
 */
export function parseSmokeOutput(text) {
  const jsonText = extractJsonObject(text);
  const parsed = JSON.parse(jsonText);
  const result = resultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `local proxy JSON did not match schema: ${result.error.message}. Response excerpt: ${excerpt(text)}`,
    );
  }

  return result.data;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function extractJsonObject(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error(
    `local proxy response did not contain a JSON object. Response excerpt: ${excerpt(text)}`,
  );
}

/**
 * @param {SmokeResult} result
 * @returns {number}
 */
export function countToolCalls(result) {
  return allToolCalls(result).length;
}

/**
 * @param {SmokeResult} result
 * @param {string} toolName
 * @returns {number}
 */
export function countToolCallsByName(result, toolName) {
  return allToolCalls(result).filter((call) => call.toolName === toolName).length;
}

/**
 * @param {{ config: Pick<SmokeConfig, "requireTool">, output: Pick<SmokeOutput, "ok" | "summary">, outputValidatorCallCount: number, readToolCallCount: number }} options
 */
export function validateOutput({ config, output, outputValidatorCallCount, readToolCallCount }) {
  if (!output.ok) {
    throw new Error(`local proxy returned ok=false: ${output.summary}`);
  }

  if (config.requireTool && readToolCallCount === 0) {
    throw new Error("local proxy completed, but the model did not call the agentool read tool.");
  }

  if (config.requireTool && outputValidatorCallCount === 0) {
    throw new Error("local proxy completed, but the model did not call output_validator.");
  }
}

/**
 * @param {Env} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function numberEnv(env, name, fallback) {
  const rawValue = env[name];
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return value;
}

/**
 * @param {Env} env
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function booleanEnv(env, name, fallback) {
  const rawValue = env[name];
  if (!rawValue) {
    return fallback;
  }

  return rawValue.toLowerCase() === "true";
}

/**
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || "<empty>";
}

/**
 * @param {SmokeResult} result
 * @returns {SmokeToolCall[]}
 */
function allToolCalls(result) {
  return result.steps.flatMap((step) => step.toolCalls);
}

/**
 * @param {Env} env
 * @param {string} name
 * @returns {string}
 */
export function requiredEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

/**
 * @param {SmokeReport} report
 * @param {Logger} logger
 */
export function logReport(report, logger) {
  logger.log(`[git-vibe] local proxy smoke passed with model=${report.model}`);
  logger.log(
    `[git-vibe] toolCalls=${report.toolCallCount} observedTools=${
      report.toolEvents.join(",") || "<none>"
    }`,
  );
  logger.log(`[git-vibe] packageName=${report.packageName}`);
  logger.log(`[git-vibe] observedAgentoolSpecifier=${report.observedAgentoolSpecifier}`);
}

/**
 * @param {string} moduleUrl
 * @param {string | undefined} scriptPath
 * @returns {boolean}
 */
export function isDirectRun(moduleUrl, scriptPath) {
  if (!scriptPath) {
    return false;
  }

  return moduleUrl === pathToFileURL(scriptPath).href;
}
