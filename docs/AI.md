# AI Architecture

## Context Assembly And Analysis

All investigation, validation, materialization, implementation, review, and PR
feedback remediation runs must build context from the full GitHub conversation,
not just the initial description.

```mermaid
flowchart TD
  A[Issue or discussion body] --> C[Conversation timeline]
  B[Comments, discussion replies, review comments] --> C
  C --> D[Sort by created time ascending]
  D --> E[Attach parent/thread references]
  E --> F[Classify author authority]
  F --> G[Weighted analysis prompt]
  G --> H[Questions, validation, materialization, implementation, review, or feedback brief]
```

Context assembly rules:

- Include the issue or discussion title and body first.
- Include all issue comments, discussion comments, discussion replies, pull request comments, and pull request review threads relevant to the current stage.
- For PR feedback investigation, include unresolved current review threads plus the GitVibe source issue, linked source discussion, parent issues, sub-issues, and their comments.
- Include `source.comment` metadata when the run was triggered by a command comment. The model should answer that source directly; deterministic GitVibe publishing decides whether the target supports a true threaded reply or needs a flat comment with a source link.
- Sort every item by creation time ascending. For threaded discussion replies, preserve the parent comment reference while still making the final analysis timeline chronological.
- Include author, author association, repository permission when available, timestamp, URL, reactions, and whether the comment was authored by GitVibe or another bot.
- Treat newer maintainer clarification as stronger than older lower-authority speculation, but do not discard contributor or guest reports; they may contain reproduction details.
- Weight analysis by authority: admin/owner/maintain > write/collaborator/member > contributor > first-time contributor/guest/none.
- When repository permission and `author_association` disagree, repository permission is stronger for approval and command authorization; `author_association` remains useful analysis metadata.

The same context assembly and weighted analysis pipeline applies to bug
investigation, feature discussion validation, materialization, implementation,
review, and PR feedback handling.

## Stage Contracts

GitVibe should treat AI as a set of stage-specific workers behind stable contracts. The GitVibe server/orchestrator owns permissions, state transitions, labels, workflow dispatch, and traceability. AI workers only produce structured recommendations, comments, code changes, or review results for the stage they are assigned.

```mermaid
flowchart TD
  A[GitHub webhook or workflow dispatch] --> B[Orchestrator]
  B --> C[Build context packet]
  C --> D[Select stage contract]
  D --> E[Select profile or role-group plan]
  E --> F[Run AI job or role-group member jobs]
  F --> G[Validate one structured result]
  G --> H{Policy gate}
  H -->|allowed| I[Post comment, update labels, dispatch next workflow, or push branch]
  H -->|blocked| J[Post explanation and wait for human context]
```

AI integration layers:

- Orchestrator: deterministic code that validates actor permissions, reads config, builds context, enforces stage gates, and writes GitHub state.
- Context builder: gathers issue/discussion/PR timelines, repo snapshots, relevant files, reactions, workflow history, and linked artifacts into a stage-specific context packet.
- Stage contracts: typed task definitions for investigation, validation,
  materialization, implementation, pull request creation, review, and feedback
  remediation.
- AI adapter: `ai-sdk-agentool` is the primary adapter for all AI SDK-backed work. Structured-only stages use the same adapter with no tools or read-only tools.
- CLI adapters: `cli-codex` and `cli-claude-code` run fixed non-interactive CLI commands, stream CLI output to the action log, and parse structured output.
- External mention adapter: not currently implemented; the shipped config keeps
  `commands.allow_external_agent_mentions` disabled.
- Result validator: checks that AI output matches the stage schema, references the supplied context, and does not request disallowed actions.

Implemented stage contracts:

| Stage                 | Schema                   | Repository scope                        | Output                                                                           | May advance state                                                |
| --------------------- | ------------------------ | --------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `investigate`         | `investigate.v1`         | Issue timeline, or PR feedback context  | Findings, blocking questions, implementation plan, or PR feedback classification | May mark issue investigated/blocked or PR feedback state         |
| `validate`            | `validate.v1`            | Issue or Discussion context             | Readiness decision, contradictions, questions, implementation brief              | May mark issue ready for approval or Discussion validated        |
| `materialize`         | `materialize.v2`         | Accepted validated Discussion           | One or more implementation issue drafts with dependencies and review guidance    | Creates `gvi:story` implementation issues and closes source      |
| `implement`           | `implement.v1`           | `git-vibe/{root-issue}` issue branch    | Working tree changes, test rationale, implementation summary                     | Uses branch-update engine; may commit and push issue branch      |
| `create-pr`           | `create-pr.v1`           | GitVibe issue branch                    | Pull request title and body                                                      | Creates or updates the PR and marks source issue `gvi:pr-opened` |
| `review-matrix`       | `review-matrix.v1`       | Pull request diff and review context    | Evidence-backed findings, pass/fail result, optional inline PR comments          | May mark a PR ready or blocked, and may queue feedback retries   |
| `address-pr-feedback` | `address-pr-feedback.v1` | Existing same-repository PR head branch | Fix commits or skipped-feedback rationale                                        | Uses branch-update engine; may update PR branch, not create PR   |

There is no standalone `decompose` stage. Splitting accepted scope into
multiple implementation issues happens inside `materialize`.

AI result envelope:

```json
{
  "stage": "investigate",
  "status": "blocked",
  "confidence": 0.74,
  "summary": "...",
  "findings": [],
  "inline_comments": [],
  "blocking_questions": ["What expected behavior should implementation preserve?"],
  "questions": [],
  "assumptions": [],
  "proposed_labels": [],
  "next_state": "needs-info",
  "comment_body": "...",
  "references": []
}
```

## Execution Rules

- AI cannot authorize itself. Approval, merge, protected-label acceptance, and release decisions always require admin/collaborator authority.
- Non-write stages may publish deterministic comments and label transitions, but GitVibe applies branch and file mutations only for write stages.
- Implementation and feedback stages share deterministic branch-update mechanics
  for validation, commit, and push. Implementation targets
  `git-vibe/{root-issue}`; PR feedback targets the existing PR head branch and
  must not create a new PR.
- GitHub writes are deterministic code operations. AI returns a structured result envelope; GitVibe validates it, renders comments, updates labels, links artifacts, and dispatches workflows.
- Every AI comment should include a concise summary, concrete evidence/references, unresolved questions, and the next expected human action.
- Investigation can hand off to implementation only when `next_state` is `ready-for-implementation`, `blocking_questions` is empty, and `implementation_plan` is non-empty. Blocking maintainer decisions must not be hidden in general `questions`.
- If the AI is uncertain, finds contradictory maintainer guidance, or cannot map the request to the repository, it must stop and ask for context instead of inventing behavior.
- AI outputs must be parsed as structured data first; the human-facing comment is rendered from the validated result.
- Prompt templates and result schemas should be versioned so old workflow runs remain understandable.
- System and user prompt templates live under `prompts/<stage>/`. User prompts use XML sections for GitHub context, repository context, stage contract, and output schema.
- Stage output contracts live under `schemas/stages/` as JSON Schema files. Runner code binds each schema to `createOutputValidator` from `agentool/output-validator` and validates the final JSON again before deterministic writes.

## Repository Prompt Additions

Consumer repositories can add optional stage-specific prompt text without overriding GitVibe's built-in stage contracts, schemas, repository scope, branch/file mutation boundaries, or deterministic write behavior.

Repository prompt addition paths:

- `.git-vibe/prompts/<stage>/system.md`: appended to the rendered system prompt for that stage.
- `.git-vibe/prompts/<stage>/user.md`: appended to the rendered user prompt for that stage.

The `<stage>` folder name matches the `promptDir` from `stageDefinitions` (e.g., `investigate`, `implement`, `review-matrix`, `create-pr`, `address-pr-feedback`, `materialize`, `validate`).

When an addition file exists, GitVibe appends its contents inside an explicit `<repository_prompt_addition>` XML section after the bundled GitVibe-controlled prompt content. The XML section makes clear that the content is repository-provided additive prompt text. GitVibe does not emit the XML section when the matching file is missing or empty.

Rules:

- Repository prompt additions are additive only. They cannot replace or weaken GitVibe system rules, stage contracts, schema requirements, repository scope, branch/file mutation boundaries, allowed tools, GitHub write safety, command syntax, or output validation.
- Missing files are treated as absent optional additions and do not add empty XML tags.
- GitVibe reads additions from the consumer workspace `.git-vibe/prompts` path, not from the action asset root.
- Non-ENOENT read errors are surfaced so broken configuration is not hidden.

## Provider Strategy

- Provider execution uses `ai-sdk-agentool` with Vercel AI SDK, `agentool` 1.5.x, provider SDKs, and Zod schemas.
- Provider support should include OpenAI, Anthropic, and OpenAI-compatible custom endpoints through the same config shape.
- Additional providers should be added behind the same adapter contract, not by changing workflow stages.
- External apps such as Codex, Claude, and Copilot are not active workflow
  dispatch paths in the current implementation. GitVibe should not depend on
  private third-party state or assume they respond to bot mentions.
- Local/self-hosted model support can use the same adapter interface when operators provide an endpoint and credentials.

CLI authentication guidance:

- API-key based OpenAI, Anthropic, OpenAI-compatible proxy, or Codex API style providers should go through `ai-sdk-agentool`.
- AI profiles should read provider auth and endpoints from the `GITVIBE_AI_ENV_JSON` bundle secret. CLI profile `env` values may use either `{ from_bundle: KEY }` or literal strings when the repository owner intentionally wants the value committed in config.
- Codex CLI can use `auth_json.from_bundle` or a pre-seeded persistent `CODEX_HOME/auth.json` on a trusted self-hosted runner. When `auth_json.from_bundle` is configured, GitVibe writes refreshed Codex auth back to the repository `GITVIBE_AI_ENV_JSON` secret, so `GITVIBE_GITHUB_TOKEN` needs repository Actions secrets read/write permission.
- Claude Code CLI should use `env.CLAUDE_CODE_OAUTH_TOKEN.from_bundle` for OAuth sessions. Do not use undocumented `CLAUDE_CODE_AUTH_TOKEN` as the planned env name.
- Reusable workflows install Codex CLI or Claude Code only when the selected stage profile uses `cli-codex` or `cli-claude-code`.
- CLI commands are fixed by adapter: `cli-codex` runs `codex exec` and `cli-claude-code` runs `claude -p`. Profiles do not accept a `command` override.
- CLI adapters bypass native permission and sandbox prompts. GitVibe disables native CLI web-search/web-fetch controls where the CLI exposes them, but shell or process network egress is only a hard boundary when the runner blocks it. Run CLI profiles only on dedicated self-hosted runners with narrow tokens and no unnecessary host mounts.

## Profile-Based Routing

GitVibe routes AI work through named profiles and optional named role groups. A
profile owns the adapter, auth source, model, reasoning settings, generation
defaults, and provider-specific escape hatches. Each AI stage must choose
`profile` for single execution or `role_group` for read-only matrix fanout;
GitVibe rejects the old `profiles` stage array.

```yaml
ai:
  profiles:
    local_proxy:
      adapter: ai-sdk-agentool
      # Optional: set to the selected model's context window to log context_used_pct.
      # context_window_tokens: 128000
      provider:
        type: openai-compatible
        # Prefer direct model names when each profile should choose its own model.
        model: glm-5
        base_url:
          from_bundle: GITVIBE_AI_BASE_URL
        api_key:
          from_bundle: GITVIBE_AI_API_KEY
      reasoning:
        effort: high

    codex_cli:
      adapter: cli-codex
      auth_json:
        from_bundle: CODEX_AUTH_JSON
      model: gpt-5.3-codex
      context:
        files:
          - AGENTS.md
      reasoning:
        effort: high
        summary: concise

    claude_code:
      adapter: cli-claude-code
      env:
        CLAUDE_CODE_OAUTH_TOKEN:
          from_bundle: CLAUDE_OAUTH_TOKEN
      model: opus
      reasoning:
        effort: xhigh

  role_groups:
    review_gate:
      synthesizer: codex_cli
      parallel: 2
      roles:
        - role: correctness.md
          profile: codex_cli
        - role: security.md
          profile: codex_cli

  stages:
    investigate:
      profile: codex_cli
    materialize:
      profile: codex_cli
    create-pr:
      profile: codex_cli
    review-matrix:
      role_group: review_gate
```

Role definitions live in `.git-vibe/role-group/*.md`. A role group entry pairs a
role markdown file with the exact profile that should run it. The synthesizer
profile receives the configured role definitions and successful role outputs,
can inspect repository and GitHub context, and returns the same final stage
schema that single-profile execution returns. `role_group` is allowed only for
read-only stages: `investigate`, `validate`, and `review-matrix`.

Profile context files are explicit per-profile system prompt additions. GitVibe
does not auto-load `AGENTS.md`, `CLAUDE.md`, or Codex/Claude native context
files. When `ai.profiles.<profile>.context.files` is configured, each listed
workspace-relative file is appended to the system prompt inside a
`<git_vibe_profile_context>` block for runs using that profile, including
fallback retries, role-group members, and finalizers. Missing files, empty files,
absolute paths, `..` traversal, symlinks, directories, and paths resolving
outside the workspace fail fast.

Normalized reasoning config:

- `reasoning.effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `auto`. Adapters should reject unsupported values for the selected provider/model with a clear config error.
- `reasoning.summary`: `auto`, `concise`, `detailed`, or `none` where the adapter supports summaries.
- `context_window_tokens`: optional positive integer on an AI profile. Set this to the selected model's context window; `ai-sdk-agentool` uses it for compaction and per-step `context_used_pct` logs.
- `context.files`: optional non-empty list of relative workspace files to append to this profile's system prompt.
- `provider.api_key.from_bundle`: AI SDK provider API key inside `GITVIBE_AI_ENV_JSON`.
- `provider.base_url.from_bundle`: AI SDK provider base URL inside `GITVIBE_AI_ENV_JSON`; required for OpenAI-compatible endpoints and optional for native OpenAI.
- `env.<NAME>`: CLI-only environment mapping for spawned CLI processes. Use `{ from_bundle: KEY }` to read a key inside `GITVIBE_AI_ENV_JSON`, or a literal string for values intentionally committed in config.
- `auth_json.from_bundle`: `cli-codex` key inside `GITVIBE_AI_ENV_JSON`; the bundle value must be an escaped `auth.json` string, such as `jq -Rs . < ~/.codex/auth.json`. GitVibe writes that string to `CODEX_HOME/auth.json`, then writes refreshed Codex auth back to the repository `GITVIBE_AI_ENV_JSON` secret after successful Codex CLI execution.
- `provider_options`: adapter-specific passthrough for settings GitVibe does not normalize yet.

Adapter mappings:

- `cli-codex`: run `codex exec` with `--dangerously-bypass-approvals-and-sandbox`; do not pass `--search`; map `reasoning.effort` to Codex `model_reasoning_effort`; map `reasoning.summary` to `model_reasoning_summary`.
- `cli-claude-code`: run `claude -p` with `--dangerously-skip-permissions`; pass `--disallowedTools WebFetch,WebSearch`; pass strict JSON Schema with `--json-schema`; map `reasoning.effort` to `--effort`. GitVibe does not set `--bare` unless a profile explicitly opts in with `bare: true`.
- CLI adapters do not receive GitVibe stage tool lists or `max_turns`; Codex and Claude Code own their native agent/tool loop and run without per-tool permission prompts in this workflow.
- `ai-sdk-agentool` with native OpenAI: map `reasoning.effort` to `providerOptions.openai.reasoningEffort`; map summaries to `providerOptions.openai.reasoningSummary` where applicable; set a stable `providerOptions.openai.promptCacheKey` by default.
- `ai-sdk-agentool` with OpenAI-compatible endpoints: do not add OpenAI prompt cache request fields by default because non-OpenAI endpoints may reject unknown fields.
- `ai-sdk-agentool` with Anthropic: map `reasoning.effort` to `providerOptions.anthropic.effort`; keep lower-level `thinking` config under `provider_options.anthropic` for explicit advanced use; set `providerOptions.anthropic.cacheControl: { type: "ephemeral" }` by default.

AI SDK tool policy by stage:

Stage `tools` config is optional and only applies to the `ai-sdk-agentool` adapter. When omitted, GitVibe uses the built-in defaults below. CLI adapters do not receive these tool lists because their native agents own tool selection.

- `investigate`: read, grep, glob, diff, GitHub search, optional web
  fetch/search after domain allowlisting, and read-only `agent` subagents.
- `validate`: read, grep, glob, GitHub search, optional web fetch/search after
  domain allowlisting, and read-only `agent` subagents.
- `materialize`: read, grep, and glob.
- `implement`: read, grep, glob, edit, write, multi-edit, bash, and diff.
- `create-pr`: read, grep, glob, and diff.
- `review-matrix`: read, grep, glob, diff, and read-only `agent` subagents.
- `address-pr-feedback`: implementation tools scoped to the existing PR branch.

The `agent` tool is available only to read-only stages (`investigate`, `validate`,
and `review-matrix`). GitVibe configures child agents with read-only tools and
GitVibe-controlled system prompts. Child agents do not receive the parent prompt
automatically, so the orchestrating model must include the relevant issue or PR
context and the exact investigation question in each delegated prompt.

Web access policy:

```yaml
ai:
  security:
    web:
      # Empty or absent allowed_domains keeps website access disabled.
      allowed_domains: []
      # - github.com
      # - "*.github.com"
```

- Empty or absent `allowed_domains` exposes `github_search` for current-repository GitHub material and disables `web-search` and `web-fetch`.
- Non-empty `allowed_domains` permits AI SDK website search and fetch for matching domains. GitVibe's built-in search remains `github_search`; a general external search backend is not configured by default.
- Domain entries are exact domains or leftmost wildcards such as `*.github.com`; arbitrary regexes, URL prefixes, and hosts like `github.com.evil.example` are rejected.
- CLI adapters keep running under this policy and log that native web tools are disabled where possible. They cannot enforce domain-level network egress through CLI arguments alone.

Default AI budgets:

- `ai.budgets.default_timeout_minutes`: `60` minutes for standalone investigate, validate, materialize, and review workflows unless a workflow-specific timeout overrides it.
- `ai.budgets.review_timeout_minutes`: `60` minutes for PR review jobs and develop workflow review jobs.
- `ai.budgets.implementation_timeout_minutes`: `120` minutes for implementation jobs.
- `ai.budgets.feedback_timeout_minutes`: `120` minutes for PR feedback investigation, remediation, and follow-up review jobs.
- `ai.budgets.create_pr_timeout_minutes`: `15` minutes for PR creation/linking.
- `ai.budgets.default_max_turns`: `90` turns for stages that use reusable workflow `max_turns`.
- `ai.budgets.implementation_max_turns`: `200` turns for implementation.
- `ai.budgets.feedback_max_turns`: `120` turns for PR feedback remediation and review.
- `ai.budgets.validation_repair_max_turns`: `45` turns per repair attempt for `ai-sdk-agentool`; CLI adapters own their native loop.
- `ai.budgets.validation_repair_attempts`: `3` per implementation run.
- `ai.budgets.pr_feedback_max_iterations`: `3` `address-feedback.yml` redispatches before the PR remains blocked.
- `ai.budgets.request_retry_attempts`: `3` provider API retries.
- `ai.budgets.request_retry_delay_seconds`: `60` second default provider API retry delay; `429` retry headers override this when present.
- ai-sdk-agentool context window: each profile may set `context_window_tokens`; profiles that omit it use `200000` estimated tokens. Compaction runs before a model call when messages reach `90%` of that profile window.
