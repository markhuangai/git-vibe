import { isMap, parseDocument } from "yaml";

function testAiConfigYaml(extraAi = "") {
  const extra = extraAi.trimEnd();
  return `ai:
  profiles:
    test:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
      reasoning:
        effort: high
  stages:
    investigate:
      profile: test
    validate:
      profile: test
    materialize:
      profile: test
    review-matrix:
      profile: test
${extra ? `${extra}\n` : ""}`;
}

export function workspaceConfigWithTestAi(config = "") {
  if (!config.trim()) return `${testAiConfigYaml()}\n${defaultSafetyConfig()}`;
  if (config.trimStart().startsWith("ai:")) {
    const base = testAiConfigYaml(config.replace(/^\s*ai:\s*\n?/, ""));
    return hasRootSafetyConfig(config) ? base : `${base}\n${defaultSafetyConfig()}`;
  }

  return withDefaultSafety(config, testAiConfigYaml());
}

/**
 * @param {string} config
 * @param {string} base
 */
function withDefaultSafety(config, base) {
  const safety = hasRootSafetyConfig(config) ? "" : `\n${defaultSafetyConfig()}`;
  return `${base}${safety}\n${config}`;
}

/**
 * @param {string} config
 * @returns {boolean}
 */
function hasRootSafetyConfig(config) {
  const document = parseDocument(config);
  if (document.errors.length > 0) {
    throw new Error(`Test git-vibe.yml config is not valid YAML: ${document.errors[0]?.message}`);
  }
  return isMap(document.contents) && document.contents.has("safety");
}

function defaultSafetyConfig() {
  return `safety:
  prompt_injection_gate: false
`;
}
