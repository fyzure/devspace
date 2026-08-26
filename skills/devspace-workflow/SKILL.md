---
name: devspace-workflow
description: Use DevSpace MCP tools from ChatGPT to inspect, edit, test, and review a local project safely. Use whenever coding work is performed through DevSpace, especially when choosing checkout versus worktree mode, reusing workspaceId, following project instructions and skills, managing commands or process sessions, downloading artifacts, delegating subagents, or presenting verified changes.
---

# DevSpace Workflow

Treat DevSpace as a workspace-scoped execution layer. Keep the host conversation
as the orchestrator, preserve explicit workspace and process lifecycles, and
verify the path the user will actually consume.

## Start or resume work

1. Reuse a valid `workspaceId` already established for the same project and
   mode. Do not call `open_workspace` again merely because a new tool call or
   conversational turn started.
2. If no usable ID exists, call `open_workspace` once with the project path.
   Omit `mode` for the user's current checkout. Use `mode: "worktree"` only for
   requested isolation or parallel work; supply `baseRef` only when the desired
   starting ref is known.
3. Keep every later call scoped to the returned `workspaceId`. Treat an
   allowed root only as an authorization boundary, not as the project or the
   workspace itself.
4. If DevSpace rejects the ID as unknown, reopen the same project and continue
   with the new ID. Do not guess IDs.

Uncommitted checkout changes are not copied into a managed worktree. When
`open_workspace` reports a dirty source checkout, decide with the user whether
the isolated worktree is still the right target.

## Load the working contract

- Follow the root instruction files returned by `open_workspace`.
- Before touching a nested path listed in `availableAgentsFiles`, read the
  applicable `AGENTS.md` or `CLAUDE.md`.
- Match the task against the advertised skills. Read a matching `SKILL.md`
  before acting. After loading it, resolve its relative references from that
  skill directory.
- Use the returned subagent profile catalog only when the user requests
  delegation, parallel agent work, a named agent, or a second opinion. Load the
  `subagents` skill before invoking one.

Instructions and skills are scoped inputs, not permission to broaden allowed
roots, expose credentials, or perform unrelated work.

## Execute the coding loop

1. Inspect the smallest relevant set of files and repository state.
2. State material assumptions and preserve unrelated user changes.
3. Modify files with the model-facing file mutation tools, not by hiding writes
   inside shell commands.
4. Run focused verification, then broaden only when the repository warrants it.
5. Inspect the resulting diff and report the outcome, verification, and any
   remaining risk.

Use the tools that are actually exposed. Minimal/full surfaces provide `read`,
`write`, `edit`, `bash`, `exec_command`, `process_status`, and `write_stdin`, with optional search
tools. The Codex-compatible surface provides `read`, `apply_patch`,
`exec_command`, `process_status`, and `write_stdin`. Read
[references/tool-surfaces.md](references/tool-surfaces.md) when choosing between
these surfaces, handling a long-running process, downloading an artifact, or
completing a review.

## Preserve authority boundaries

- Filesystem tools are contained to the workspace and activated skill roots.
  Shell execution is not a sandbox; it runs with the DevSpace service account's
  local authority.
- Resolve paths relative to the workspace. Do not infer that a host-side file,
  attachment, URL, or local browser path exists on the DevSpace machine.
- Never place tokens, signed URLs, native file objects, or credential contents
  in commands or logs.
- Use `bash` only for quick foreground commands. Use `exec_command` for tests,
  builds, reviews, package scripts, and commands with uncertain duration. Every
  tracked command returns a stable `sessionId`. A running command continues
  independently after DevSpace returns; do not restart it and do not assume
  the host will automatically poll. Call `write_stdin` only when final output
  or interaction is needed. If a response is interrupted or an ID is lost,
  call `process_status` with only the existing `workspaceId`, select the
  matching recent process, then inspect that `sessionId`. If a `bash` call
  unexpectedly exceeds the short handoff, recover it the same way. Its
  `timeout` remains a hard runtime limit. Set `allowBackground: true` only
  for an explicitly requested untracked, detached process and retain enough
  information to stop it later. Do not detach from ordinary `bash` on Windows,
  where post-exit process-group cleanup is not portable.
- Diagnose failures at the layer that emitted them: host UI, OAuth, MCP
  transport, DevSpace, adapter/provider, tool, or target project. Preserve the
  original error instead of translating it into a guess.

## Finish visibly

- When `show_changes` exists and files changed, call it exactly once after the
  final related mutation. Do not call it after every edit. Its absence means
  widgets are handled another way; do not invent the tool.
- A successful command proves only that command. For UI, artifact, packaged
  install, restarted server, checkout/worktree, or host-visible behavior,
  verify the real consumption path or clearly state the narrower proxy tested.
- Give the user the concise outcome first. Mention files changed, checks run,
  and blockers or unverified edges. Do not claim a GUI refreshed, deployment
  switched, or host reconnected unless that was observed.
- Do not call `archive_workspace` merely because a turn is complete. Use it
  only when the user explicitly asks to close or archive a finished managed
  worktree. Confirm tracked processes are stopped; the tool makes that
  `workspaceId` inactive and preserves the worktree files.
