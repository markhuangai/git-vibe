function testAiConfigYaml(extraAi = "") {
  const extra = extraAi.trimEnd();
  return `ai:
  profiles:
    test:
      provider:
        type: openai-compatible
        model: glm-5
        base_url:
          from_bundle: GITVIBE_AI_BASE_URL
        api_key:
          from_bundle: GITVIBE_AI_API_KEY
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
  if (!config.trim()) return testAiConfigYaml();
  if (config.trimStart().startsWith("ai:")) {
    return testAiConfigYaml(config.replace(/^\s*ai:\s*\n?/, ""));
  }

  return `${testAiConfigYaml()}\n${config}`;
}
