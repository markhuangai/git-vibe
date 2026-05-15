# Workflow

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Intake

  Intake --> BugIssue: bug report
  Intake --> StoryDiscussion: feature or story request

  Intake --> ConvertedDiscussion: feature submitted as issue
  ConvertedDiscussion --> StoryDiscussion: create discussion, link issue, close issue

  StoryDiscussion --> FeatureValidation: validate label
  FeatureValidation --> NeedsAnswers: open questions found
  NeedsAnswers --> FeatureValidation: replies plus validate label
  FeatureValidation --> Decomposition: ready, add decompose label
  Decomposition --> NeedsAnswers: blocked, post questions
  Decomposition --> ReadyToMaterialize: plan posted, add decomposed label
  ReadyToMaterialize --> ImplementationIssue: approved label dispatches materialize

  BugIssue --> WaitingForBugInvestigation: default state, no AI work
  WaitingForBugInvestigation --> BugInvestigation: investigate command, investigate label, or reaction threshold
  BugInvestigation --> BugNeedsContext: not ready, post findings, add blocked label
  BugNeedsContext --> BugInvestigation: answers plus investigate label
  BugInvestigation --> ImplementationIssue: ready, add investigated label

  ImplementationIssue --> Development: protected approved label after investigation
  ReviewFixIssue --> Development: internal review-fix marker

  Development --> Implementation: branch, commits, validation passes
  Implementation --> ReviewMatrix: validation passes
  ReviewMatrix --> ReviewFixIssue: changes required, create internal sub-issue
  ReviewMatrix --> PullRequest: review passed, create or update PR
  PullRequest --> FeedbackInvestigation: trusted changes-requested review or address-feedback command
  FeedbackInvestigation --> PullRequest: no fixes needed, replies posted, ready-for-approval restored
  FeedbackInvestigation --> FeedbackImplementation: actionable fixes required
  FeedbackInvestigation --> FeedbackBlocked: maintainer answer required
  FeedbackImplementation --> FeedbackReviewMatrix: fixes pushed
  FeedbackReviewMatrix --> PullRequest: review passed, ready-for-approval restored
  FeedbackReviewMatrix --> FeedbackBlocked: changes still required
  PullRequest --> HumanMerge: admin or collaborator merges

  HumanMerge --> [*]
```

## Key Behavior

- Bugs remain issues.
- New bug issues do not automatically start AI work by default.
- Bug fixing is always gated: investigate first, post findings, ask for expected behavior, then approve implementation after `gvi:investigated` is present.
- If `git-vibe:approved` is added to an issue before `gvi:investigated`, GitVibe removes `git-vibe:approved` and comments with the required investigation step.
- If validation does not make sense, GitVibe aborts the session, posts its concern, removes the ready/approved automation flag, and waits for more clarification.
- Stories and feature requests begin as discussions.
- Feature requests opened through the feature request issue form are converted by creating a discussion, linking back, labeling the issue as needing discussion, and closing the issue.
- Admins and collaborators move work forward with public `/git-vibe ...`
  commands and protected labels.
- Accepted comment commands from admins and collaborators receive a `rocket` reaction before GitVibe dispatches the workflow. If the reaction cannot be added, GitVibe posts a queued workflow comment as the visible fallback.
- Status updates prefer reactions, then labels, then comments. The issue
  `git-vibe:investigate` dispatch adds `gvi:investigating` instead of a
  queued comment; label-backed and review-backed dispatches include the exact workflow run URL
  when GitHub returns it. Runner stages remove prior transient queued/running
  GitVibe status comments for the same artifact before posting the next running
  or result comment.
- Guests can submit issues, discussions, and feedback, but cannot approve work or start write automation.
- Consumer repositories may opt into community-triggered bug investigation using a reaction threshold, such as six `+1` reactions. This can only start investigation; it must never start code changes.
- GitVibe never auto-merges and never approves its own pull requests.
- External agents are optional mention partners. GitVibe may post commands like `@codex review` or `@claude ...` only after admin/collaborator opt-in or explicit config.

## Public Interfaces

Consumer config lives at:

```text
.github/git-vibe.yml
```

Initial commands:

```text
/git-vibe investigate
/git-vibe address-feedback
```

GitVibe uses `/git-vibe ...` as the only public command form. `@git-vibe ...` is intentionally unsupported so commands do not look like GitHub account mentions. GitHub does not currently provide a stable custom repository command autocomplete contract, so command parsing must work from plain comment text.

Active label flow:

```mermaid
flowchart TD
  FeatureIssue["Feature issue opened"] -->|add| NeedsDiscussion["gvi:needs-discussion"]
  NeedsDiscussion -->|create linked discussion, comment, close issue| ClosedFeatureIssue["original feature issue closed"]
  DiscussionDecompose["Validated discussion labeled git-vibe:decompose"] -->|dispatch decompose.yml| Decompose["decompose stage"]
  Decompose -->|post plan, remove decomposing, add| Decomposed["gvi:decomposed"]
  DiscussionApproved["Decomposed discussion labeled git-vibe:approved"] -->|dispatch materialize.yml| Materialize["materialize stage"]
  Materialize -->|create implementation issue with| Story["gvi:story"]
  Materialize -->|comment with implementation issue link, close discussion| ClosedDiscussion["source discussion closed"]

  IssueValidate["Issue labeled git-vibe:validate"] -->|dispatch validate.yml, remove trigger label| ValidateIssue["validate issue"]
  DiscussionValidate["Discussion labeled git-vibe:validate"] -->|dispatch validate.yml, remove trigger label| ValidateDiscussion["validate discussion"]
  ValidateIssue -->|ready for approval| ReadyForApproval["gvi:ready-for-approval"]
  ValidateDiscussion -->|ready for decompose| ValidatedDiscussion["gvi:validated"]

  IssueInvestigate["Issue labeled git-vibe:investigate"] -->|dispatch investigate.yml, remove trigger, add| Investigating["gvi:investigating"]
  Investigating -->|ready investigation posted, remove investigating, add| Investigated["gvi:investigated"]
  Investigating -->|blocked or not-ready investigation, add blocked, remove investigating| Blocked["gvi:blocked"]
  ApprovedTooEarly["Issue labeled git-vibe:approved before gvi:investigated"] -->|comment and remove| ApprovedViolation["git-vibe:approved"]
  Investigated -->|issue labeled git-vibe:approved, dispatch develop.yml| Develop["develop.yml"]
  Develop -->|implement stage| InProgress["gvi:in-progress"]

  InProgress -->|create-pr completed| PrOpened["gvi:pr-opened"]
  PrOpened -->|remove| InProgressRemoved["gvi:in-progress + gvi:investigated"]
  PrOpened -->|add label to PR| PrReady["PR gvi:ready-for-approval"]

  PrFeedback["address-feedback or trusted changes-requested review"] -->|remove ready, add| PrInvestigating["PR gvi:investigating"]
  PrInvestigating -->|no fixes needed, reply to feedback| PrReady
  PrInvestigating -->|fixes required| PrInvestigated["PR gvi:investigated"]
  PrInvestigating -->|questions or unsafe feedback| PrBlocked["PR gvi:blocked"]
  PrInvestigated -->|feedback implementation starts| PrInProgress["PR gvi:in-progress"]
  PrInProgress -->|review-matrix passed, remove investigated| PrReady
  PrInProgress -->|review-matrix changes required| PrBlocked

  PrApprovedEvent["Trusted PR approval submitted"] -->|add to PR| PrApproved["PR gvi:pr-approved"]
  PrApprovedEvent -->|remove stale source label| ApprovalCleanup["git-vibe:approved"]

  PrMergedEvent["GitVibe PR merged"] -->|remove ready, add to PR| PrApproved
  PrMergedEvent -->|add to source issue| PrMerged["gvi:pr-merged"]
  PrMergedEvent -->|remove stale source labels| MergeCleanup["git-vibe:approved + gvi:pr-opened + gvi:pr-approved"]

  ReviewMatrix["review-matrix requires fixes"] -->|create issue or PR marker and| ReviewFix["gvi:review-fix"]
```

Active public trigger labels:

```text
git-vibe:validate
git-vibe:decompose
git-vibe:investigate
git-vibe:approved
```

Active internal runtime labels:

```text
gvi:needs-discussion
gvi:story
gvi:ready-for-approval
gvi:validated
gvi:validating
gvi:decomposed
gvi:decomposing
gvi:investigated
gvi:investigating
gvi:blocked
gvi:in-progress
gvi:pr-opened
gvi:pr-approved
gvi:pr-merged
gvi:review-fix
```

`gvi:` labels are private GitVibe runtime labels. Maintainers should not add
them manually; GitVibe creates missing managed labels on app startup and on the
first webhook seen for a repository.

### Fine-Grained PAT Permissions

Required fine-grained PAT repository permissions:

| Permission    | Access     | Required for                                                         |
| ------------- | ---------- | -------------------------------------------------------------------- |
| Metadata      | Read       | Repository lookup, collaborator checks, and metadata                 |
| Variables     | Read       | Reading GitHub Actions repository variables                          |
| Actions       | Read/write | Workflow dispatch, workflow runs, and artifacts                      |
| Contents      | Read/write | Contents, commits, branches, releases, and merges                    |
| Discussions   | Read/write | Discussions, comments, and discussion labels                         |
| Issues        | Read/write | Issues, comments, assignees, labels, and milestones                  |
| Pull requests | Read/write | Pull requests, comments, assignees, labels, and merges               |
| Secrets       | Read/write | Updating `GITVIBE_AI_ENV_JSON` after Codex CLI refreshes `auth.json` |
| Workflows     | Read/write | Updating GitHub Actions workflow files                               |

Only `Metadata` and `Variables` are always read-only. `Secrets` needs read/write
access only when a `cli-codex` profile uses `auth_json.from_bundle`; GitVibe
then writes refreshed Codex auth back to the repository `GITVIBE_AI_ENV_JSON`
secret. Every other listed permission needs read/write access.

GitHub labels are not natively protected per label. GitVibe must treat public
trigger labels and internal `gvi:` labels as protected by policy: only
configured admin/collaborator roles may add or remove them, and the server must
verify the webhook sender on every relevant label event before dispatching
automation. If an unauthorized actor adds a protected `git-vibe:*` or `gvi:*`
label, GitVibe removes the label, posts an audit comment, and does not start the
pipeline. Known `gvi:*` runtime labels never dispatch workflows from label
events. If anyone adds `gvi:review-fix` without a valid GitVibe hidden marker,
GitVibe removes it. Issue follow-ups use `kind=issue`; pull request feedback
retries use `kind=pull-request`.

## Pipeline

```mermaid
flowchart TD
  subgraph ParentRun[Develop run for current issue]
    A[Investigated approved issue or review-fix issue] --> E[Implement job using issue timeline]
    E --> F[Run configured validation]
    F --> G{Validation passes?}
    G -->|no| H[Repair implementation attempt]
    H --> F
    G -->|yes| I[Commit and push root branch]
    I --> J[Plan review-matrix stage]
    J --> K[Run member job or role-group member jobs]
    K --> L[Finalizer validates one review result]
    L --> M{Review result}
    M -->|changes required| N[Create internal review-fix issue with details]
    N --> O[Comment on parent and link sub-issue]
    O --> P[Dispatch new develop run]
    P --> Q[Fail current run before PR creation]
    M -->|review passed| R[Create or update PR]
    R --> S[Wait for human review]
  end

  subgraph FollowUpRun[Next develop run for review-fix issue]
    T[Review-fix issue] --> U[Implement fixes on existing root branch]
    U --> V[Plan review-matrix stage]
    V --> W[Run member job or role-group member jobs]
    W --> X[Finalizer validates one review result]
    X --> Y{Review result}
    Y -->|changes required| Z[Create next review-fix issue and fail run]
    Y -->|review passed| AA[Create or update PR for issue chain]
  end

  P -. starts .-> T
```

Review matrix role groups are configured through `ai.role_groups`. Each role
entry pairs a `.git-vibe/role-group/*.md` role definition with the AI profile
that runs it, and the configured synthesizer profile merges successful role
outputs into one final `review-matrix.v1` result.

The implementation stage has an inner validation repair loop. GitVibe runs the
configured `tests.commands` mechanically after the AI returns JSON. If a command
fails, GitVibe feeds the failed command, bounded stdout/stderr excerpts, git
status, and diff stat back into the implementation stage for a bounded repair
attempt before any commit is created. `validation_repair_attempts` is scoped to
one implementation run, and each repair attempt gets
`validation_repair_max_turns` turns for adapters that support turn limits.

The review matrix is a separate gate after implementation. Review findings must
be evidence-backed required fixes; speculative or over-engineering suggestions
are non-blocking. When review returns `changes-required`, GitVibe posts a brief
comment on the current issue, creates a `gvi:review-fix` issue containing the
detailed review findings, links it as a native sub-issue, and dispatches another
development run, then the current run fails before PR creation. Review-fix runs
start at implementation, checkout the existing root implementation branch when
their hidden marker names one, and implement only the required review fixes.
When a review-fix run eventually returns `review-passed`, that later run creates
or updates the pull request for the full issue chain.

## Bug Investigation Flow

Bug reports have a separate investigation-only path before implementation. The
goal is to let AI help capture reproduction evidence, likely affected code,
suspected root cause, missing information, and expected behavior questions
without changing code.

Investigation is completed before the `develop` workflow starts. A trusted actor
can add `git-vibe:investigate` or run `/git-vibe investigate` to dispatch
`investigate.yml`; the label path removes `git-vibe:investigate` and adds
`gvi:investigating` after dispatch. A not-ready investigation posts its
findings and blocking questions, adds `gvi:blocked`, removes
`gvi:investigating`, and waits for maintainer answers. Maintainers answer
the questions and add `git-vibe:investigate` to retry. A ready investigation
posts the investigation result to the issue, removes `gvi:investigating`,
and adds `gvi:investigated`.

For issues, `git-vibe:approved` is valid only after `gvi:investigated` is
present. If approval is added too early, GitVibe removes `git-vibe:approved` and
comments with the required investigation step. The later `develop.yml`
implementation run reads the posted investigation result from the issue
timeline. Human-facing investigation and validation comments stay concise; full
structured stage output remains available in the workflow result artifact.

```mermaid
sequenceDiagram
  participant Guest as Guest or Community
  participant Issue as Bug Issue
  participant App as GitVibe Server
  participant AI as Investigation Pipeline
  participant Maint as Admin or Collaborator

  Guest->>Issue: Open bug report
  App->>Issue: Record bug report without starting AI work
  Note over App,Issue: No AI work starts by default

  alt label trigger
    Maint->>Issue: Apply git-vibe:investigate
    App->>AI: Dispatch investigation-only workflow
    App->>Issue: Replace git-vibe:investigate with gvi:investigating
  else command trigger
    Maint->>Issue: /git-vibe investigate
    App->>AI: Dispatch investigation-only workflow
  end
  AI->>Issue: Post findings, likely root cause, and expected behavior questions

  alt investigation is ready
    AI->>Issue: Post ready investigation and implementation plan
    App->>Issue: Remove gvi:investigating and add gvi:investigated
    Maint->>Issue: Apply git-vibe:approved label
    App->>AI: Dispatch develop workflow
  else investigation is blocked
    App->>Issue: Add gvi:blocked and remove gvi:investigating
    Maint->>Issue: Answer blocking questions
    Maint->>Issue: Re-apply git-vibe:investigate
  end
```

Community-triggered investigation is optional and configured per repository. Because GitHub reactions are API-readable but are not a reliable standalone workflow trigger, GitVibe should evaluate reaction thresholds during issue events, comment events, and/or a scheduled scan. The threshold path may only dispatch the investigation-only workflow.

Example config shape:

```yaml
bug_investigation:
  auto_start_on_new_bug: false
  community_trigger:
    enabled: true
    reaction: "+1"
    threshold: 6
    dispatch: investigate
```

## Feature Refinement Flow

Feature discussions use the same weighted full-conversation analysis as bugs. The goal is to convert a long discussion into an actionable implementation issue only after behavior, scope, constraints, and acceptance criteria are clear.

```mermaid
sequenceDiagram
  participant Community as Community
  participant Disc as Feature Discussion
  participant App as GitVibe Server
  participant AI as Validation, Decomposition, and Materialization Pipeline
  participant Maint as Admin or Collaborator
  participant Issue as Implementation Issue

  Community->>Disc: Open and discuss feature request
  Note over Disc,App: GitVibe reads body, comments, replies, reactions, and author authority

  Maint->>Disc: Apply git-vibe:validate label
  App->>AI: Dispatch validation workflow
  AI->>Disc: Confirm actionable state or request more answers

  Maint->>Disc: Apply git-vibe:decompose label
  App->>AI: Dispatch decompose workflow
  AI->>Disc: Post one decomposition plan comment with embedded JSON

  Maint->>Disc: Apply git-vibe:approved label
  App->>AI: Dispatch materialize workflow
  App->>Issue: Create implementation issue with backlinks and accepted decomposition
  App->>Disc: Link implementation issue
  App->>Disc: Close resolved Discussion
```

## PR Feedback Loop

Pull request feedback remediation is a separate single-stage workflow, not the
full `develop.yml` implementation, review-matrix, and PR creation sequence. It
adds PR conversation and review-thread context, checks out the existing PR
branch, applies actionable feedback, pushes fix commits, and posts a completion
summary back to the triggering surface.

```mermaid
sequenceDiagram
  participant M as Admin or Collaborator
  participant PR as Pull Request
  participant App as GitVibe Server
  participant WF as Feedback Workflow
  participant Agent as GitVibe Coding Agent

  M->>PR: Submit changes-requested review or /git-vibe address-feedback
  PR->>App: Webhook review or command event
  App->>App: Validate actor permission
  App->>PR: Add rocket reaction for command, or queued comment for review/fallback
  App->>WF: Dispatch feedback workflow with source-comment metadata
  WF->>PR: Remove gvi:ready-for-approval and add gvi:investigating
  WF->>Agent: Provide PR, source issue, linked discussion, parent issue, sub-issue, and open review-thread context
  Agent->>PR: Publish feedback investigation and reply to false-positive or already-addressed review comments
  alt Fixes required
    WF->>PR: Add gvi:investigated, then gvi:in-progress
    Agent->>PR: Push fixes to the existing PR head branch
    WF->>Agent: Plan review-matrix, run member job(s), and finalize one result
    alt Review passes
      WF->>PR: Remove gvi:review-fix and add gvi:ready-for-approval
    else Review still requires changes
      WF->>PR: Post review result, add gvi:blocked and gvi:review-fix
      WF->>App: Queue another address-feedback.yml run, max 3
    end
  else No fixes needed
    WF->>PR: Restore gvi:ready-for-approval without implementation
  else Blocked
    WF->>PR: Add gvi:blocked and wait for maintainer answers
  end
```

Admins and collaborators can also run `/git-vibe address-feedback` in the pull
request conversation as a manual retry path. Individual review-comment webhooks
do not dispatch automation; GitVibe waits for the submitted review state and
only treats trusted `changes_requested` reviews as the automatic signal.
The reusable workflow runs `investigate` in PR-feedback mode first, skips coding
when no fixes are needed, and runs `address-pr-feedback` plus `review-matrix`
only for actionable feedback.

## Linking And Traceability

GitVibe must make every generated artifact discoverable from the others.

- When a feature issue is converted to a discussion, the closed issue gets a comment linking the discussion, and the discussion body or first bot comment links the original issue.
- When a discussion becomes an implementation issue, the issue body links the source discussion, the issue gets `gvi:story`, and the discussion gets a comment linking the implementation issue.
- Webhook-triggered command workflows carry `source-comment` metadata so result comments can target the triggering surface. Discussions use threaded replies; issue, pull request conversation, and submitted-review triggers use flat comments with an explicit source link. Pull request review-comment replies remain supported for existing metadata.
- When the app dispatches automation from a comment command, a successful `rocket` reaction is the acknowledgement and GitVibe does not also post a queued comment. Protected label dispatches, trusted review dispatches, and failed command reactions still use queued comments with hidden metadata and the exact workflow run URL when GitHub returns it. When a runner stage actually starts, the runner posts a running comment containing the workflow run URL and a hidden metadata marker for the stage and source artifact. These queued/running comments are transient: GitVibe deletes matching prior transient status comments and keeps durable result, traceability, investigation, and validation comments.
- Implementation branches use the deterministic format `git-vibe/{root-issue-number}`. Review-fix issues carry a hidden marker that points back to the root branch.
- When a pull request is created, the PR body references the source issue chain. If the PR targets the repository default branch, use closing keywords such as `Closes #123`; if it targets a non-default branch, still include explicit issue links because GitHub closing keywords only create linked issues for default-branch PRs.
- When a pull request is opened by GitVibe, the source issue gets `gvi:pr-opened`, stale source `gvi:in-progress`, `gvi:investigated`, and `gvi:ready-for-approval` labels are removed, and the PR gets `gvi:ready-for-approval`.
- During PR feedback handling, the PR owns one active workflow-state label at a time among `gvi:investigating`, `gvi:investigated`, `gvi:in-progress`, `gvi:blocked`, and `gvi:ready-for-approval`; the source issue remains at `gvi:pr-opened`.
- When PR feedback review still returns `changes-required`, the PR gets a durable review-matrix result comment, `gvi:blocked`, and PR-scoped `gvi:review-fix`; GitVibe queues another `address-feedback.yml` run until the PR has three review-fix markers.
- When a trusted reviewer approves a GitVibe pull request, the PR gets `gvi:pr-approved`, PR `gvi:ready-for-approval` is removed, and stale source `git-vibe:approved` is removed.
- When a GitVibe pull request is merged before default-branch closure, the PR gets `gvi:pr-approved`, PR `gvi:ready-for-approval` is removed, the source issue gets `gvi:pr-merged`, and stale source workflow state labels are removed.
- The source issue gets a comment linking the PR and latest workflow run.
- PR feedback runs add comments linking the feedback workflow run, changed commits, and any review comments that were skipped with rationale.
- Prefer GitHub-native references (`#123`, full issue/discussion/PR URLs, and workflow run URLs) so GitHub creates backlinks and rich references where supported; use explicit bot comments where GitHub does not create a first-class link automatically.
