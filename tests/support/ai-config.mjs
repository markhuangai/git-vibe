export function testAiConfigYaml(extraAi = "") {
  const extra = extraAi.trimEnd();
  return `ai:
  profiles:
    test:
      provider:
        type: openai-compatible
        model_variable: GITVIBE_AI_MODEL
        base_url_variable: GITVIBE_AI_BASE_URL
        api_key_secret: GITVIBE_AI_API_KEY
  stages:
    investigate:
      profile: test
    summarize:
      profile: test
    validate:
      profile: test
    materialize:
      profile: test
    implement:
      profile: test
    review-matrix:
      profiles:
        - test
    create-pr:
      profile: test
    address-pr-feedback:
      profile: test
${extra ? `${extra}\n` : ""}`;
}

export function workspaceConfigWithTestAi(config = "") {
  if (!config.trim()) return testAiConfigYaml();
  if (config.trimStart().startsWith("ai:")) {
    return testAiConfigYaml(config.replace(/^\s*ai:\s*\n?/, ""));
  }

  return `${testAiConfigYaml()}\n${config}`;
}
