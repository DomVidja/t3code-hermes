# Hermes patches

Patches this fork carries against [Hermes Agent](https://github.com/NousResearch/hermes-agent)
itself, for behaviour T3 Code depends on that stock Hermes does not provide. They are here rather
than vendored because Hermes is a separate project on its own release cadence — apply them to your
own checkout, and drop them once upstream carries the change.

The server embeds these files, and the Hermes panel's Patches tab applies them for you. After
changing, adding, or removing a patch here, run `node scripts/generate-hermes-patches.ts` and add or
drop its entry in `apps/server/src/hermes/hermesPatches.ts`; a test fails until both match.

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

The remote target needs only SSH, Bash, and the project toolchain (not even `scp`). It does not need
Node, T3, the Hermes binary, provider credentials, memories, or a `.hermes` directory.

Upstream already carries half of this: `SSHEnvironment` takes `sync_files`, used by Hermes's own SSH
workspace browser. The patch exposes it as config and roots ACP tools at the remote cwd.

Verified against hermes-agent `ac0cfa7db9` (`main`, 2026-09-29), which is where `hermes update`
takes a source checkout by default. Tagged releases up to v2026.9.24 predate a reorganisation of the
terminal config code, so the patch does not apply to them or to older checkouts; update first.

```bash
cd ~/.hermes/hermes-agent
git apply /path/to/t3code/infra/hermes/0002-acp-central-ssh-execution.patch
```

Restart the T3 Code server after applying the patch. Configure each approved SSH target as a
separate Hermes provider instance; do not change the default Hermes instance away from local
execution.

## `0003-acp-delegation-progress.patch`

**Needed by:** live progress and background results for the subagents Hermes delegates to. Without
it, stock Hermes suppresses `delegate_task`'s structured arguments and results and never reports
child progress over ACP, so T3 Code parses the readable text and shows background subagents as idle
once dispatched.

The patch keeps the existing human-readable content while exposing `rawInput` arguments, parsed
`rawOutput` results, and bounded per-child snapshots in `rawOutput.hermesDelegation`. Child progress
routes through the executor's copied context variables, never goals, task indices, or FIFO order:
overlapping delegations can have identical goals and batch-local indices, and unknown or conflicting
ownership is dropped. Registry-forced stalls and worker crashes report through the same child relay,
so detached work cannot stay falsely active. A parent result with `status: "dispatched"` only
acknowledges launch; child lifecycle events settle each subagent. The original ACP process must stay
connected; missed results are not recovered from disk.

Verified against hermes-agent `ac0cfa7db9` (`main`, 2026-09-29), together with `0002`. It does not
apply to `08b140d14e` or older checkouts; update first.

```bash
cd ~/.hermes/hermes-agent
git apply /path/to/t3code/infra/hermes/0003-acp-delegation-progress.patch
```

Restart the T3 Code server after applying the patch so provider sessions spawn patched Hermes. No
configuration changes are required.

The patch's `tests/acp_adapter/test_delegation_progress.py` and `test_delegation_finalization.py`
drive the real executor, child relays, stale monitor, and background worker. Run them with
`tests/acp_adapter/test_tools.py` and `test_events.py` in a scratch checkout with an isolated
`HERMES_HOME` and `PYTHONDONTWRITEBYTECODE=1`, never in the live install.

## `0004-acp-background-reports.patch`

**Needed by:** the sidebar's Monitoring status for background processes Hermes starts, such as a CI
watcher. Stock Hermes reports a background `terminal` call as finished the moment the process starts
and says nothing when it exits, so T3 Code cannot tell the work is still running.

The patch adds two ACP extension notifications. `_hermes/process` reports a background process left
running by a `terminal` call, keyed by that tool call, and again when it exits, with its exit code.
`_hermes/notification` carries the text Hermes's CLI injects as the next turn when background work
finishes (process completions, watch matches, heartbeats, background subagent results), sent once the
session is idle. Stock ACP never drains those events, so an agent that promised to report back never
heard that its work had finished. ACP turns stay client-driven: Hermes reports, and the client decides
whether to prompt. Clients that do not know the methods ignore them.

Verified against hermes-agent `645bb146c6` (`main`, 2026-10-01), alone and together with `0002` and
`0003` in either order. Like `0003`, it does not apply to `08b140d14e` or older checkouts; update
first.

```bash
cd ~/.hermes/hermes-agent
git apply /path/to/t3code/infra/hermes/0004-acp-background-reports.patch
```

Restart the T3 Code server after applying the patch. `display.background_process_notifications: off`
in Hermes's `config.yaml` still suppresses process notifications; process status is always reported.

The patch's `tests/acp_adapter/test_background_reports.py` spawns real processes against an isolated
process registry. Run it with the rest of `tests/acp_adapter/` in a scratch checkout, as for `0003`.
