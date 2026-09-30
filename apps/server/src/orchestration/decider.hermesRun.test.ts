import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadHermesRun,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-09-30T00:00:00.000Z";

const run = (sessionId: string, live: boolean): ThreadHermesRun => ({
  profile: "upstream-sync",
  sourceKey: "webhook:upstream-sync",
  sourceLabel: "webhook/upstream-sync",
  sessionId,
  latestSessionId: sessionId,
  live,
});

function makeThread(id: string, hermesRun: ThreadHermesRun | null): OrchestrationThread {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    hermesRun,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

const readModel = (threads: OrchestrationThread[]): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  threads,
  updatedAt: NOW,
});

const reply = (threadId: string) =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make(`reply-${threadId}`),
    threadId: ThreadId.make(threadId),
    message: {
      messageId: MessageId.make(`message-${threadId}`),
      role: "user",
      text: "Keep the fork's composer and push",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: NOW,
  }) as const;

it.layer(NodeServices.layer)("Hermes run threads", (it) => {
  it.effect("records the run state on the thread", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.hermes-run.set",
          commandId: CommandId.make("hermes-run:upstream-sync:s1:ended"),
          threadId: ThreadId.make("run-1"),
          hermesRun: run("s1", false),
          createdAt: NOW,
        },
        readModel: readModel([makeThread("run-1", run("s1", true))]),
      });
      expect(event).toMatchObject({
        type: "thread.hermes-run-set",
        payload: { hermesRun: { live: false }, updatedAt: NOW },
      });
    }),
  );

  it.effect("holds replies while any run of the same source is live", () =>
    Effect.gen(function* () {
      const threads = [makeThread("run-1", run("s1", false)), makeThread("run-2", run("s2", true))];
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: reply("run-1"), readModel: readModel(threads) }),
      );
      expect(error.message).toContain("Hermes is still running webhook/upstream-sync");
    }),
  );

  it.effect("lets a reply through once the source's runs have finished", () =>
    Effect.gen(function* () {
      const threads = [makeThread("run-1", run("s1", false)), makeThread("chat", null)];
      const events = yield* decideOrchestrationCommand({
        command: reply("run-1"),
        readModel: readModel(threads),
      });
      expect(Array.isArray(events) ? events.map((event) => event.type) : [events.type]).toContain(
        "thread.turn-start-requested",
      );
    }),
  );
});
