import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * @typedef {{ default?: unknown, required?: boolean, type?: string }} WorkflowInput
 * @typedef {{ permissions?: Record<string, unknown>, uses?: string, with?: Record<string, unknown> }} WorkflowJob
 * @typedef {{ jobs?: Record<string, WorkflowJob>, on?: { workflow_call?: { inputs?: Record<string, WorkflowInput> }, workflow_dispatch?: { inputs?: Record<string, WorkflowInput> } } }} Workflow
 */

const sourceWorkflowDirectory = ".github/workflows";
const consumerWorkflowDirectory = "examples/consumer/.github/workflows";
const internalWorkflowCallInputs = new Set(["action-repository", "action-ref"]);
const reusableWorkflowPattern = /^markhuangai\/git-vibe\/\.github\/workflows\/([^@\s]+)@.+$/;
const inputExpressionPattern = /^\${{\s*inputs\.([A-Za-z0-9_-]+)\s*}}$/;
const permissionLevels = new Map([
  ["none", 0],
  ["read", 1],
  ["write", 2],
]);
/** @type {Array<keyof WorkflowInput>} */
const inputMetadataKeys = ["default", "required", "type"];

/** @type {string[]} */
const errors = [];

for (const templateFile of workflowFiles(consumerWorkflowDirectory)) {
  checkTemplateWorkflow(templateFile);
}

if (errors.length > 0) {
  console.error(
    `Workflow template contract check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log("Workflow template contracts are aligned.");
}

/** @param {string} templateFile */
function checkTemplateWorkflow(templateFile) {
  const templatePath = join(consumerWorkflowDirectory, templateFile);
  const template = readWorkflow(templatePath);
  const reusableJob = findReusableWorkflowJob(template);
  if (!reusableJob) {
    errors.push(`${templatePath} must call a markhuangai/git-vibe reusable workflow.`);
    return;
  }

  const reusableName = reusableWorkflowName(reusableJob.uses);
  if (!reusableName) {
    errors.push(`${templatePath} has unsupported reusable workflow reference: ${reusableJob.uses}`);
    return;
  }

  const sourcePath = join(sourceWorkflowDirectory, reusableName);
  const source = readWorkflow(sourcePath);
  checkReusableInputs(templatePath, sourcePath, template, reusableJob, source);
  checkReusablePermissions(templatePath, sourcePath, reusableJob, source);
}

/**
 * @param {string} templatePath
 * @param {string} sourcePath
 * @param {Workflow} template
 * @param {WorkflowJob} reusableJob
 * @param {Workflow} source
 */
function checkReusableInputs(templatePath, sourcePath, template, reusableJob, source) {
  const sourceInputs = source.on?.workflow_call?.inputs || {};
  const dispatchInputs = template.on?.workflow_dispatch?.inputs || {};
  const withInputs = reusableJob.with || {};

  checkForwardedInputs(templatePath, sourcePath, withInputs, sourceInputs);
  checkSupportedWithKeys(templatePath, sourcePath, withInputs, sourceInputs);
  checkDispatchInputForwarding(templatePath, dispatchInputs, withInputs);
  checkForwardedInputMetadata(templatePath, sourcePath, dispatchInputs, withInputs, sourceInputs);
}

/**
 * @param {string} templatePath
 * @param {string} sourcePath
 * @param {Record<string, unknown>} withInputs
 * @param {Record<string, WorkflowInput>} sourceInputs
 */
function checkForwardedInputs(templatePath, sourcePath, withInputs, sourceInputs) {
  for (const name of Object.keys(sourceInputs)) {
    if (internalWorkflowCallInputs.has(name)) continue;
    if (!Object.hasOwn(withInputs, name)) {
      errors.push(`${templatePath} must pass ${name} to ${sourcePath}.`);
    }
  }
}

/**
 * @param {string} templatePath
 * @param {string} sourcePath
 * @param {Record<string, unknown>} withInputs
 * @param {Record<string, WorkflowInput>} sourceInputs
 */
function checkSupportedWithKeys(templatePath, sourcePath, withInputs, sourceInputs) {
  for (const name of Object.keys(withInputs)) {
    if (!Object.hasOwn(sourceInputs, name)) {
      errors.push(`${templatePath} passes ${name}, but ${sourcePath} does not declare it.`);
    }
  }
}

/**
 * @param {string} templatePath
 * @param {Record<string, WorkflowInput>} dispatchInputs
 * @param {Record<string, unknown>} withInputs
 */
function checkDispatchInputForwarding(templatePath, dispatchInputs, withInputs) {
  for (const name of Object.keys(dispatchInputs)) {
    if (withInputs[name] !== `\${{ inputs.${name} }}`) {
      errors.push(`${templatePath} dispatch input ${name} must be forwarded to with.${name}.`);
    }
  }
}

/**
 * @param {string} templatePath
 * @param {string} sourcePath
 * @param {Record<string, WorkflowInput>} dispatchInputs
 * @param {Record<string, unknown>} withInputs
 * @param {Record<string, WorkflowInput>} sourceInputs
 */
function checkForwardedInputMetadata(
  templatePath,
  sourcePath,
  dispatchInputs,
  withInputs,
  sourceInputs,
) {
  for (const [withName, value] of Object.entries(withInputs)) {
    const inputName = expressionInputName(value);
    if (!inputName) continue;
    if (inputName !== withName) {
      errors.push(`${templatePath} with.${withName} must reference inputs.${withName}.`);
      continue;
    }
    if (!Object.hasOwn(dispatchInputs, inputName)) {
      errors.push(`${templatePath} must declare workflow_dispatch input ${inputName}.`);
      continue;
    }
    checkInputMetadata(
      templatePath,
      sourcePath,
      inputName,
      dispatchInputs[inputName],
      sourceInputs[withName],
    );
  }
}

/**
 * @param {string} templatePath
 * @param {string} sourcePath
 * @param {string} name
 * @param {WorkflowInput | undefined} dispatchInput
 * @param {WorkflowInput | undefined} sourceInput
 */
function checkInputMetadata(templatePath, sourcePath, name, dispatchInput, sourceInput) {
  for (const key of inputMetadataKeys) {
    if (!sameValue(dispatchInput?.[key], sourceInput?.[key])) {
      errors.push(
        `${templatePath} input ${name}.${key} must match ${sourcePath}: ${formatValue(sourceInput?.[key])}.`,
      );
    }
  }
}

/**
 * @param {string} templatePath
 * @param {string} sourcePath
 * @param {WorkflowJob} reusableJob
 * @param {Workflow} source
 */
function checkReusablePermissions(templatePath, sourcePath, reusableJob, source) {
  const requiredPermissions = maximumWorkflowPermissions(source);
  const wrapperPermissions = reusableJob.permissions || {};

  for (const [name, requiredValue] of Object.entries(requiredPermissions)) {
    if (wrapperPermissions[name] !== requiredValue) {
      errors.push(
        `${templatePath} permissions.${name} must match maximum requested by ${sourcePath}: ${requiredValue}.`,
      );
    }
  }

  for (const name of Object.keys(wrapperPermissions)) {
    if (!Object.hasOwn(requiredPermissions, name)) {
      errors.push(
        `${templatePath} grants permissions.${name}, but ${sourcePath} does not request it.`,
      );
    }
  }
}

/** @param {Workflow} workflow @returns {Record<string, string>} */
function maximumWorkflowPermissions(workflow) {
  /** @type {Record<string, string>} */
  const permissions = {};

  for (const job of Object.values(workflow.jobs || {})) {
    for (const [name, value] of Object.entries(job.permissions || {})) {
      const permission = String(value);
      if (!permissionLevels.has(permission)) continue;
      if (permissionLevel(permission) > permissionLevel(permissions[name])) {
        permissions[name] = permission;
      }
    }
  }

  return permissions;
}

/** @param {string | undefined} permission @returns {number} */
function permissionLevel(permission) {
  return permissionLevels.get(permission || "none") || 0;
}

/** @param {Workflow} workflow @returns {WorkflowJob | undefined} */
function findReusableWorkflowJob(workflow) {
  return Object.values(workflow.jobs || {}).find((job) =>
    reusableWorkflowPattern.test(String(job.uses || "")),
  );
}

/** @param {unknown} uses @returns {string | undefined} */
function reusableWorkflowName(uses) {
  return reusableWorkflowPattern.exec(String(uses || ""))?.[1];
}

/** @param {unknown} value @returns {string | undefined} */
function expressionInputName(value) {
  return inputExpressionPattern.exec(String(value || ""))?.[1];
}

/** @param {string} directory @returns {string[]} */
function workflowFiles(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".yml"))
    .sort();
}

/** @param {string} path @returns {Workflow} */
function readWorkflow(path) {
  try {
    return parse(readFileSync(path, "utf8")) || {};
  } catch (error) {
    errors.push(
      `${path} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

/** @param {unknown} left @param {unknown} right @returns {boolean} */
function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** @param {unknown} value @returns {string} */
function formatValue(value) {
  return value === undefined ? "undefined" : JSON.stringify(value);
}
