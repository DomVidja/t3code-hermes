# Hermes patches

Patches this fork carries against [Hermes Agent](https://github.com/NousResearch/hermes-agent)
itself, for behaviour T3 Code depends on that stock Hermes does not provide. They are here rather
than vendored because Hermes is a separate project on its own release cadence — apply them to your
own checkout, and drop them once upstream carries the change.

## `0001-acp-honor-reasoning-config.patch`

**Needed by:** the composer's Reasoning selector on the Hermes provider. Without this patch the
selector still renders and still writes your `~/.hermes/config.yaml`, but Hermes ignores the file
when talking ACP, so nothing changes for a T3 Code session. The written level does take effect in
`hermes chat` in a terminal.

**What it fixes:** every Hermes surface resolves reasoning effort through the single chokepoint
`hermes_constants.resolve_reasoning_config` (per-model `agent.reasoning_overrides` beats global
`agent.reasoning_effort`) — CLI startup, the messaging gateway, Desktop/TUI, cron, the `/model`
switch, and fallback activation. The ACP adapter is the exception: `acp_adapter/session.py`'s
`_make_agent` builds its `AIAgent` kwargs without `reasoning_config`, so `agent_init` leaves it
`None` and the provider default wins no matter what the config says. `--reasoning` does not help
either — `cmd_acp` builds the ACP argv from only `--version`, `--check`, `--setup`,
`--setup-browser`, and `--yes`, so the flag is dropped before the adapter ever sees it.

The patch resolves the level in `_make_agent`, where the loaded config is already in hand. Because
`set_session_model` rebuilds the agent through the same function, a level changed in `config.yaml`
is picked up on the next agent build instead of only on a Hermes restart — which is what lets T3
Code apply a new level to the next turn of a running thread by re-sending the current model.

Verified against hermes-agent `3c108589fbcaa7284ac9b4b31c0f1c75ac76cd47`.

```bash
cd ~/.hermes/hermes-agent   # or wherever your Hermes checkout lives
git apply /path/to/t3code/infra/hermes/0001-acp-honor-reasoning-config.patch
```

Restart the T3 Code server afterwards so provider sessions spawn a patched Hermes.

## `0002-acp-central-ssh-execution.patch`

**Needed by:** a single central T3/Hermes server that executes terminal and file tools on a remote
SSH host without launching T3 or Hermes on that target.

Hermes already has an SSH terminal backend, but its default behavior mirrors local credentials,
skills, and cache into the remote user's `~/.hermes`. This patch adds
`terminal.ssh_sync_files: false`, which keeps those files on the central Hermes host. It also makes
ACP honor `terminal.cwd` as the remote project root instead of replacing it with T3's local project
placeholder.

Example central provider-instance environment:

```text
TERMINAL_ENV=ssh
TERMINAL_SSH_HOST=192.168.1.5
TERMINAL_SSH_USER=aeris
TERMINAL_SSH_KEY=/home/aeris/.ssh/id_ed25519_aeris_core_fleet
TERMINAL_CWD=/home/aeris/meridian-news-v3-standalone
TERMINAL_SSH_SYNC_FILES=false
```

The remote target needs only SSH, Bash, and the project toolchain. It does not need Node, T3, the
Hermes binary, provider credentials, memories, or a `.hermes` directory.

```bash
cd ~/.hermes/hermes-agent
git apply /path/to/t3code/infra/hermes/0002-acp-central-ssh-execution.patch
```

Restart the T3 Code server after applying the patch. Configure each approved SSH target as a
separate Hermes provider instance; do not change the default Hermes instance away from local
execution.

## `0003-acp-delegation-progress.patch`

**Needed by:** live, per-child delegation progress in T3 Code's Hermes ACP sessions. Stock Hermes
suppresses `delegate_task`'s structured arguments/results and ignores child progress in its ACP
adapter. The patch retains the existing human-readable content while exposing `rawInput` arguments,
parsed `rawOutput` results, and bounded `rawOutput.hermesDelegation` child updates.

Verified against hermes-agent `08b140d14e6c1d49f9b7ad02c9437fe940d54d65` with ACP SDK `0.9.0`.
This patch applies independently; the earlier patches target older Hermes revisions and may need
rebasing separately.

```bash
git -C /path/to/hermes-agent apply --check /path/to/t3code/infra/hermes/0003-acp-delegation-progress.patch
git -C /path/to/hermes-agent apply /path/to/t3code/infra/hermes/0003-acp-delegation-progress.patch
```

Restart the T3 Code server after applying the patch so provider sessions spawn patched Hermes.
No configuration changes are required. The patch does not change delegation execution or enable
providers/toolsets.

The patch routes child progress through the executor's copied context variables, not goals, task
indices, or FIFO order: overlapping delegations can have identical goals and batch-local indices.
Unknown or conflicting ownership is dropped. Alternative Hermes runtimes must propagate worker
context for this routing to work. Registry-forced stalls and worker crashes notify the same child
relay under the captured context, so detached work cannot remain falsely active.

Child updates carry bounded per-child snapshots in `rawOutput.hermesDelegation`, keeping the ACP
parent tool `in_progress` even when one child completes. The T3 adapter bypasses parent-wide update
coalescing for this envelope. A parent result with `status: "dispatched"` only acknowledges launch;
only child lifecycle events settle a background subagent. These updates require the original ACP
process to remain connected; the patch does not recover missed results from disk.

The patch's `tests/acp/test_delegation_progress.py` and `test_delegation_finalization.py` exercise
executor preflight, child relays, copied worker contexts, and registry completion. Run them alongside
`tests/acp/test_tools.py` and
`tests/acp/test_events.py` in a scratch checkout with an isolated `HERMES_HOME` and
`PYTHONDONTWRITEBYTECODE=1`. If the installed venv lacks ACP or pytest, install dependencies with
`pip --target` into a temporary directory and add it to `PYTHONPATH`, not the live venv.
