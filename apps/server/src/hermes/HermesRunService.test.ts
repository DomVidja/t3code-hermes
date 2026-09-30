// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HERMES_STATE_DDL, insertHermesMessage, insertHermesSession } from "./hermesRunFixtures.ts";
import * as HermesRunService from "./HermesRunService.ts";

const PROJECT_ID = ProjectId.make("project-fork");
const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "t3code-hermes",
  workspaceRoot: "/w/t3code-hermes",
  repositoryIdentity: {
    canonicalKey: "github.com/nateweav/t3code-hermes",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/NateWeav/t3code-hermes.git",
    },
    displayName: "NateWeav/t3code-hermes",
    provider: "github",
    owner: "NateWeav",
    name: "t3code-hermes",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

/** A Hermes home with the resolver's profile: its route, filter script, and state store. */
function makeHermesHome() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-home-"));
  const home = NodePath.join(root, "profiles", "upstream-sync");
  NodeFS.mkdirSync(NodePath.join(home, "scripts"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(home, "config.yaml"),
    `platforms:
  webhook:
    extra:
      routes:
        upstream-sync:
          events: [issues]
          prompt: "Resolve the upstream conflict"
          script: t3code-upstream-conflict.py
`,
  );
  NodeFS.writeFileSync(
    NodePath.join(home, "scripts", "t3code-upstream-conflict.py"),
    'REPOSITORY = "NateWeav/t3code-hermes"\n',
  );
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "state.db"));
  db.exec(HERMES_STATE_DDL);
  db.close();
  const withDb = (write: (db: NodeSqlite.DatabaseSync) => void) => {
    const handle = new NodeSqlite.DatabaseSync(NodePath.join(home, "state.db"));
    try {
      write(handle);
    } finally {
      handle.close();
    }
  };
  return { root, home, withDb };
}

function makeLayer(
  root: string,
  options: {
    readonly hermesEnabled?: boolean;
    readonly liveThreads?: ReadonlyArray<OrchestrationThreadShell>;
    /** Rejects the first dispatch of this command type, as a transient failure would. */
    readonly failOnce?: OrchestrationCommand["type"];
  } = {},
) {
  let failPending = options.failOnce;
  const dispatched: OrchestrationCommand[] = [];
  const bindings: Array<{ readonly resumeCursor: unknown }> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.suspend(() => {
          if (command.type === failPending) {
            failPending = undefined;
            return Effect.die(new Error("transient"));
          }
          dispatched.push(command);
          return Effect.succeed({ sequence: dispatched.length });
        }),
    }),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getProjectShells: () => Effect.succeed([project]),
      getProjectShellById: (projectId) =>
        Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      getThreadShellById: (threadId) =>
        Effect.succeed(
          dispatched.some(
            (command) => command.type === "thread.create" && command.threadId === threadId,
          )
            ? Option.some({
                id: threadId,
                projectId: PROJECT_ID,
              } as unknown as OrchestrationThreadShell)
            : Option.none(),
        ),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [project],
          threads: options.liveThreads ?? [],
          updatedAt: "2026-09-30T00:00:00.000Z",
        }),
    }),
    Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
      upsert: (binding) =>
        Effect.sync(() => {
          bindings.push({ resumeCursor: binding.resumeCursor });
        }),
    }),
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("hermes")]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: options.hermesEnabled ?? true,
          environment: [{ name: "HERMES_HOME", value: root, sensitive: false }],
        },
      },
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-hermes-runs-" }),
  );
  return {
    dispatched,
    bindings,
    layer: HermesRunService.layer.pipe(
      Layer.provide(dependencies),
      Layer.provide(NodeServices.layer),
    ),
  };
}

const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => millis / 1000);

describe("HermesRunService", () => {
  it.live("discovers a profile's webhook route and suggests the repository it names", () => {
    const hermes = makeHermesHome();
    const { layer } = makeLayer(hermes.root);
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      const listed = yield* service.listSources;
      expect(listed.hermesEnabled).toBe(true);
      expect(listed.sources).toMatchObject([
        {
          profile: "upstream-sync",
          sourceKey: "webhook:upstream-sync",
          kind: "webhook",
          label: "upstream-sync",
          detail: "issues",
          configured: true,
          projectId: null,
          suggestedProjectId: PROJECT_ID,
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("mirrors a switched-on source's run from start to finish, once", () => {
    const hermes = makeHermesHome();
    const { layer, dispatched, bindings } = makeLayer(hermes.root);
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      const switchedOn = yield* service.setSource({
        profile: "upstream-sync",
        sourceKey: "webhook:upstream-sync",
        projectId: PROJECT_ID,
      });
      expect(switchedOn.sources[0]?.projectId).toBe(PROJECT_ID);

      const startedAt = (yield* nowSeconds) + 1;
      hermes.withDb((db) => {
        insertHermesSession(db, {
          id: "run-1",
          source: "webhook",
          route: "upstream-sync",
          startedAt,
          toolCallCount: 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-1",
          role: "user",
          content: "Resolve the upstream conflict",
          timestamp: startedAt,
        });
        insertHermesMessage(db, {
          sessionId: "run-1",
          role: "assistant",
          toolCalls: [{ id: "call-1", name: "terminal", args: { command: "gh pr create --fill" } }],
          timestamp: startedAt + 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-1",
          role: "tool",
          toolCallId: "call-1",
          content: JSON.stringify({
            output: "https://github.com/NateWeav/t3code-hermes/pull/72",
            exit_code: 0,
          }),
          timestamp: startedAt + 2,
        });
      });

      yield* service.sync;
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.hermes-run.set",
        "thread.session.set",
        "thread.message.user.append",
        "thread.activity.append",
        "thread.activity.append",
        "thread.pull-request.link",
      ]);
      expect(dispatched[1]).toMatchObject({
        hermesRun: { profile: "upstream-sync", sourceLabel: "webhook/upstream-sync", live: true },
      });
      expect(dispatched[2]).toMatchObject({ session: { status: "running" } });
      expect(dispatched[6]).toMatchObject({ repository: "nateweav/t3code-hermes", number: 72 });
      expect(bindings[0]?.resumeCursor).toEqual({ schemaVersion: 1, hermesHome: hermes.home });

      hermes.withDb((db) => {
        insertHermesMessage(db, {
          sessionId: "run-1",
          role: "assistant",
          content: "Blocked: ChatComposer.tsx needs your call. PR left open.",
          timestamp: startedAt + 3,
        });
        db.prepare(
          "UPDATE sessions SET ended_at = ?, end_reason = 'webhook_complete' WHERE id = 'run-1'",
        ).run(startedAt + 4);
      });
      dispatched.length = 0;
      yield* service.sync;
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.message.assistant.delta",
        "thread.message.assistant.complete",
        "thread.session.set",
        "thread.session.set",
        "thread.hermes-run.set",
      ]);
      expect(dispatched.slice(2, 4)).toMatchObject([
        { session: { status: "ready" } },
        { session: { status: "stopped" } },
      ]);
      expect(dispatched[4]).toMatchObject({ hermesRun: { live: false } });
      const primer = (bindings.at(-1)?.resumeCursor as { primer?: string } | undefined)?.primer;
      expect(primer).toContain("Blocked: ChatComposer.tsx needs your call.");
      expect(primer).toContain("https://github.com/NateWeav/t3code-hermes/pull/72");

      dispatched.length = 0;
      yield* service.sync;
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("never creates a thread for a run that had nothing to report", () => {
    const hermes = makeHermesHome();
    const { layer, dispatched } = makeLayer(hermes.root);
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      yield* service.setSource({
        profile: "upstream-sync",
        sourceKey: "webhook:upstream-sync",
        projectId: PROJECT_ID,
      });
      const startedAt = (yield* nowSeconds) + 1;
      hermes.withDb((db) => {
        insertHermesSession(db, {
          id: "run-quiet",
          source: "webhook",
          route: "upstream-sync",
          startedAt,
          endedAt: startedAt + 2,
          endReason: "webhook_complete",
          toolCallCount: 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-quiet",
          role: "assistant",
          toolCalls: [{ id: "call-q", name: "terminal", args: { command: "git fetch" } }],
          timestamp: startedAt,
        });
        insertHermesMessage(db, {
          sessionId: "run-quiet",
          role: "assistant",
          content: "[SILENT]",
          timestamp: startedAt + 1,
        });
      });
      yield* service.sync;
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("finishes a run that was live across a restart, in its own project", () => {
    const hermes = makeHermesHome();
    const liveThread = {
      id: ThreadId.make("hermes-run:upstream-sync:run-restart"),
      projectId: PROJECT_ID,
      hermesRun: {
        profile: "upstream-sync",
        sourceKey: "webhook:upstream-sync",
        sourceLabel: "webhook/upstream-sync",
        sessionId: "run-restart",
        latestSessionId: "run-restart",
        live: true,
      },
    } as unknown as OrchestrationThreadShell;
    // The source is no longer switched on: the run must still finish.
    const { layer, dispatched } = makeLayer(hermes.root, { liveThreads: [liveThread] });
    return Effect.gen(function* () {
      const startedAt = (yield* nowSeconds) - 60;
      hermes.withDb((db) => {
        insertHermesSession(db, {
          id: "run-restart",
          source: "webhook",
          route: "upstream-sync",
          startedAt,
          endedAt: startedAt + 30,
          endReason: "webhook_complete",
          toolCallCount: 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-restart",
          role: "assistant",
          content: "Needs your call on the composer.",
          timestamp: startedAt + 20,
        });
      });
      const service = yield* HermesRunService.HermesRunService;
      yield* service.sync;
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.message.assistant.delta",
        "thread.message.assistant.complete",
        "thread.session.set",
        "thread.session.set",
        "thread.hermes-run.set",
      ]);
      expect(dispatched.at(-1)).toMatchObject({ hermesRun: { live: false } });
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses to switch a source on while Hermes is off", () => {
    const hermes = makeHermesHome();
    const { layer } = makeLayer(hermes.root, { hermesEnabled: false });
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      const error = yield* Effect.flip(
        service.setSource({
          profile: "upstream-sync",
          sourceKey: "webhook:upstream-sync",
          projectId: PROJECT_ID,
        }),
      );
      expect(error.reason).toBe("providerDisabled");
    }).pipe(Effect.provide(layer));
  });

  it.live("retries a run after a transient failure instead of dropping it", () => {
    const hermes = makeHermesHome();
    const { layer, dispatched } = makeLayer(hermes.root, {
      failOnce: "thread.message.assistant.delta",
    });
    return Effect.gen(function* () {
      const service = yield* HermesRunService.HermesRunService;
      yield* service.setSource({
        profile: "upstream-sync",
        sourceKey: "webhook:upstream-sync",
        projectId: PROJECT_ID,
      });
      const startedAt = (yield* nowSeconds) + 1;
      hermes.withDb((db) => {
        insertHermesSession(db, {
          id: "run-flaky",
          source: "webhook",
          route: "upstream-sync",
          startedAt,
          endedAt: startedAt + 5,
          endReason: "webhook_complete",
          toolCallCount: 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-flaky",
          role: "assistant",
          toolCalls: [{ id: "call-f", name: "terminal", args: { command: "git fetch" } }],
          timestamp: startedAt + 1,
        });
        insertHermesMessage(db, {
          sessionId: "run-flaky",
          role: "assistant",
          content: "Done.",
          timestamp: startedAt + 2,
        });
      });
      yield* service.sync;
      expect(dispatched.some((command) => command.type === "thread.hermes-run.set")).toBe(true);
      expect(dispatched.at(-1)?.type).not.toBe("thread.hermes-run.set");
      yield* service.sync;
      expect(dispatched.at(-1)).toMatchObject({
        type: "thread.hermes-run.set",
        hermesRun: { live: false },
      });
    }).pipe(Effect.provide(layer));
  });
});
