# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

ChatGPT may support automatic checkout recovery through optional host
conversation metadata. This is an OpenAI-host adapter detail, not a standard MCP
conversation field. When that optional context is available, opening the same
checkout project again in the same conversation can continue in the existing
workspace, and the context already provided for that reused checkout is not
repeated. The portable workflow remains the same: keep using the `workspaceId`
returned by `open_workspace` for later operations. Hosts without supported
conversation context receive a normal new workspace and continue with that
explicit `workspaceId` workflow.
The model receives actionable workspace instructions; automatic-reuse
bookkeeping is not a model-facing choice.

Worktree mode is deliberately different: every call creates a new managed
worktree and a new workspace session with complete context, even for the same
path and base ref.

The first successful open of a checkout provides complete instructions and
coding context. A repeated open that reuses the same checkout workspace does
not repeat the model-visible context, but the workspace UI continues to show the
complete details. Every new worktree establishes and returns its own complete
context, even when the same project was already opened in checkout or another
worktree. Opening checkout after a worktree therefore provides the checkout's
own context.

Do not call `open_workspace` again for the same checkout folder unless:

- the `workspaceId` is rejected as unknown
- work moves to a different project folder
- work switches between checkout and worktree mode
- the user asks for a new isolated worktree

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Each worktree-mode call creates a new managed worktree and returns a new
`workspaceId`. Reuse that ID for work inside that worktree; call
`open_workspace` in worktree mode again only when another isolated worktree is
actually required.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

Call `archive_workspace` only when the user explicitly asks to close or archive
a finished managed worktree. The operation makes the DevSpace workspace ID
inactive and preserves the worktree directory.
Do not archive a workspace merely because one response or conversational turn
has finished.

## Project Instructions

When a workspace opens, DevSpace loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `devspace-workflow` skill for the ChatGPT-facing workspace,
  tool, process, artifact, review, and verification workflow
- the bundled `subagents` skill when Subagents are enabled, unless `~/.devspace/skills/subagents/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/effort levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output. Enable Subagents
and choose providers through `devspace init` or the persisted provider
configuration. The bundled `subagents` skill teaches the minimal
`devspace agents targets`, `devspace agents ls`, `devspace agents run`,
`devspace agents continue`, and `devspace agents show` workflow. The catalog
comes from `open_workspace`; `devspace agents ls` lists existing subagent
sessions for that workspace.

## Tool Names

DevSpace exposes these tool names:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`
- `exec_command`
- `process_status`
- `write_stdin`

By default, DevSpace also runs in `DEVSPACE_TOOL_MODE=minimal`, so dedicated
`grep`, `glob`, and `ls` tools are hidden. Use `bash` with command-line tools
such as `rg`, `find`, and `ls` for quick search and directory inspection.
`exec_command`, `process_status`, and `write_stdin` are available in minimal and full modes for
tracked commands.

Use `DEVSPACE_TOOL_MODE=full` to restore dedicated search and directory tools.

The experimental Codex-style surface is enabled with
`DEVSPACE_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `process_status`
- `write_stdin`

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered.

## Show Changes

By default, `DEVSPACE_WIDGETS=full`.

In that mode, DevSpace attaches widget UI only to `open_workspace` and
`show_changes`. Ordinary file, edit, search, shell, and process tools remain
plain MCP tools.

Use `DEVSPACE_WIDGETS=off` to disable widget UI metadata. `show_changes` remains
available either way. The historical `DEVSPACE_WIDGETS=changes` value is still
accepted and is now equivalent to `full`.

Call `show_changes` exactly once after the final file modification in any turn
that changes files. It shows the combined changes for that turn and advances the
review point automatically. Reusing a workspace does not change this workflow.

## Shell and Process Sessions

Use `bash` for quick foreground terminal checks. Use `exec_command` for:

- tests
- builds
- reviews
- git inspection
- package scripts
- environment checks

Every `exec_command` call returns a stable process session ID. A command still
running after the short server-controlled handoff continues independently;
ChatGPT does not need to poll to keep it alive. Do not restart the command.
Call `write_stdin` when the workflow needs to wait briefly for final output,
send input, resize a PTY, or send Ctrl-C. Set `tty: true` only for commands that
need a terminal.

If ChatGPT loses the result or a response is interrupted, call `process_status`
with only the existing `workspaceId` to list recent processes. Then call it
with the selected `sessionId` to read the retained transcript and final state.
This recovery path does not depend on ChatGPT remembering or automatically
polling a prior tool result.

If the host selects `bash` for a command that unexpectedly runs long, DevSpace
returns a stable tracked `sessionId` after about two seconds and keeps the
command running. The `timeout` argument still controls the hard runtime limit;
it does not keep the original MCP request open. Explicit untracked
`allowBackground: true` calls are exempt from this automatic handoff.

On POSIX systems the foreground shell owns its descendants by default.
DevSpace terminates background processes that remain after the shell exits.
Set `allowBackground: true` only when the user explicitly requests a detached
process and retain enough information to stop it later. Do not detach from
ordinary `bash` on Windows. Prefer the tracked `exec_command`/`write_stdin`
process lifecycle in every tool mode.

File writes should go through the edit/write tools rather than shell
redirection, heredocs, `tee`, `sed -i`, or generated scripts.
