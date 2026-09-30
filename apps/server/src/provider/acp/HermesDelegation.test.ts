import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as AcpSchema from "effect-acp/schema";
import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import { foldSubagentActivities } from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import {
  mergeToolCallState,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";
import { HermesDelegations, isHermesDelegationProgress } from "./HermesDelegation.ts";
import fixture from "./fixtures/hermes-delegation.json" with { type: "json" };
import olderFixture from "./fixtures/hermes-delegation-08b140d1.json" with { type: "json" };

const decodeNotification = Schema.decodeUnknownSync(AcpSchema.SessionNotification);
const turnId = TurnId.make("hermes-turn-1");
const batch = fixture.cases.find((item) => item.name === "batch")!;
const dispatched = fixture.cases.find((item) => item.name === "dispatched")!;

function tool(update: unknown, previous?: AcpToolCallState) {
  const notification = decodeNotification({
    sessionId: "hermes-session",
    update,
  });
  const event = parseSessionUpdateEvent(notification).events.find(
    (event) => event._tag === "ToolCallUpdated",
  );
  if (!event || event._tag !== "ToolCallUpdated")
    throw new Error("Fixture is not an ACP tool call");
  return mergeToolCallState(previous, event.toolCall);
}

function progress(start: AcpToolCallState, value: Record<string, unknown>) {
  return tool(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: start.toolCallId,
      status: "in_progress",
      rawOutput: { hermesDelegation: value },
    },
    start,
  );
}

describe("Hermes delegate_task ACP boundary", () => {
  it("pins actual stock formatter output, not an invented raw JSON result", () => {
    expect(fixture.hermesCommit).toBe("ac0cfa7db94cefa90cf3e35191f38b53888b9e17");
    expect(olderFixture.hermesCommit).toBe("08b140d14e6c1d49f9b7ad02c9437fe940d54d65");
    for (const scenario of [...fixture.cases, ...olderFixture.cases]) {
      expect(scenario.start).not.toHaveProperty("rawInput");
      expect(scenario.complete).not.toHaveProperty("rawOutput");
      expect(scenario.start.kind).toBe("execute");
    }
  });

  // Hermes renamed stock titles ("delegate: goal" became "delegate_task: goal").
  it.each([fixture, olderFixture])(
    "recognizes stock delegations from Hermes $hermesCommit",
    (pinned) => {
      for (const scenario of pinned.cases) {
        const events = new HermesDelegations().update(tool(scenario.start), turnId)!;
        const titles = events
          .filter((event) => event.type === "task.started")
          .map((event) => event.payload.title);
        expect(titles).toEqual(
          scenario.name === "batch"
            ? ["Inspect routing", "Run tests"]
            : [scenario.name === "dispatched" ? "Review parser" : "Review the parser"],
        );
      }
    },
  );

  it("starts every batch child pending, extracting stock goals and roles", () => {
    const events = new HermesDelegations().update(tool(batch.start), turnId)!;
    expect(
      events.filter((event) => event.type === "task.started").map((event) => event.payload),
    ).toEqual([
      {
        taskId: "tc-fixture-batch:task:0",
        taskType: "subagent",
        toolUseId: "tc-fixture-batch",
        title: "Inspect routing",
        agentIndex: 0,
        role: "orchestrator",
        description: "Inspect routing",
      },
      {
        taskId: "tc-fixture-batch:task:1",
        taskType: "subagent",
        toolUseId: "tc-fixture-batch",
        title: "Run tests",
        agentIndex: 1,
        role: "leaf",
        description: "Run tests",
      },
    ]);
    expect(
      events.filter((event) => event.type === "task.progress").map((event) => event.payload.status),
    ).toEqual(["pending", "pending"]);
  });

  it.each(fixture.cases.filter((item) => item.name !== "dispatched"))(
    "parses stock $name completion status and detail",
    (scenario) => {
      const state = new HermesDelegations();
      const start = tool(scenario.start);
      state.update(start, turnId);
      const completed = state.update(tool(scenario.complete, start), turnId)!;
      const results = completed.filter((event) => event.type === "task.completed");
      if (scenario.name === "single") {
        expect(results[0]?.payload).toMatchObject({
          status: "completed",
          model: "test/reviewer",
          role: "leaf",
          summary: "Parser reviewed.",
          typedUsage: { durationMs: 2500 },
        });
      } else if (scenario.name === "batch") {
        expect(results.map((event) => event.payload.status)).toEqual(["completed", "failed"]);
        expect(results[0]?.payload).toMatchObject({
          summary: "Routing inspected.",
          typedUsage: { durationMs: 1500 },
        });
        expect(results[1]?.payload).toMatchObject({
          summary: "Test process failed.",
          model: "test/tester",
          typedUsage: { durationMs: 2000 },
        });
      } else {
        expect(results[0]?.payload).toMatchObject({
          status: "failed",
          summary: "Delegation unavailable.",
        });
      }
      expect(state.finish("interrupted")).toEqual([]);
    },
  );

  it("prefers structured args/results over clipped display content", () => {
    const state = new HermesDelegations();
    const start = tool({ ...batch.start, rawInput: batch.args });
    expect(state.update(start, turnId)?.[0]?.payload).toMatchObject({ model: "test/researcher" });
    const events = state.update(
      tool({ ...batch.complete, content: [], rawOutput: batch.result }, start),
      turnId,
    )!;
    expect(
      events
        .filter((event) => event.type === "task.completed")
        .map((event) => event.payload.status),
    ).toEqual(["completed", "failed"]);
  });

  it("keeps short interleaved child progress and ignores duplicate/late text", () => {
    const state = new HermesDelegations();
    const start = tool({ ...batch.start, rawInput: batch.args });
    state.update(start, turnId);
    for (const index of [0, 1]) {
      const tick = progress(start, { event: "subagent.text", task_index: index, text: "Hi" });
      expect(isHermesDelegationProgress(tick)).toBe(true);
      expect(state.update(tick, turnId)?.[0]?.payload).toMatchObject({
        taskId: `tc-fixture-batch:task:${index}`,
        status: "running",
        summary: "Hi",
      });
      expect(state.update(tick, turnId)).toEqual([]);
    }
    state.update(
      progress(start, {
        event: "subagent.complete",
        task_index: 0,
        status: "completed",
        summary: "Done",
      }),
      turnId,
    );
    expect(
      state.update(
        progress(start, { event: "subagent.text", task_index: 0, text: "Late" }),
        turnId,
      ),
    ).toEqual([]);
    expect(
      state.update(
        progress(start, { event: "subagent.text", task_index: 99, text: "Unknown child" }),
        turnId,
      ),
    ).toEqual([]);
  });

  it("does not confuse stock background dispatch with successful completion", () => {
    const state = new HermesDelegations();
    const start = tool(dispatched.start);
    state.update(start, turnId);
    const events = state.update(tool(dispatched.complete, start), turnId)!;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task.progress",
      payload: {
        status: "idle",
        summary: "Dispatched in background; stock Hermes ACP does not report child completion.",
      },
    });
    expect(state.finish("interrupted", undefined, { turnId, preserveBackground: true })).toEqual(
      [],
    );
  });

  it("attributes patched background completion to the original turn", () => {
    const state = new HermesDelegations();
    const start = tool({ ...dispatched.start, rawInput: dispatched.args });
    state.update(start, turnId);
    state.update(tool({ ...dispatched.complete, rawOutput: dispatched.result }, start), turnId);
    expect(state.finish("interrupted", undefined, { turnId, preserveBackground: true })).toEqual(
      [],
    );
    const events = state.update(
      progress(start, {
        event: "subagent.complete",
        task_index: 0,
        status: "completed",
        summary: "Background done.",
      }),
      TurnId.make("new-turn"),
    )!;
    expect(events[0]).toMatchObject({
      type: "task.completed",
      turnId,
      payload: { summary: "Background done." },
    });
  });

  it("settles incomplete children on interruption and does not steal another turn's background tasks", () => {
    const state = new HermesDelegations();
    const start = tool(batch.start);
    state.update(start, turnId);
    expect(
      state.finish("cancelled", undefined, {
        turnId: TurnId.make("other"),
        preserveBackground: false,
      }),
    ).toEqual([]);
    expect(state.finish("cancelled").map((event) => event.payload)).toEqual([
      expect.objectContaining({ taskId: "tc-fixture-batch:task:0", status: "cancelled" }),
      expect.objectContaining({ taskId: "tc-fixture-batch:task:1", status: "cancelled" }),
    ]);
    expect(
      state.update(
        tool({
          sessionUpdate: "tool_call_update",
          toolCallId: start.toolCallId,
          status: "in_progress",
          rawOutput: { hermesDelegation: { event: "subagent.text", task_index: 0, text: "Late" } },
        }),
      ),
    ).toEqual([]);
  });

  it("keeps delegate controls and unrelated commands out of the roster", () => {
    const state = new HermesDelegations();
    for (const action of ["list", "steer", "stop"]) {
      expect(
        state.update(
          tool({ ...batch.start, title: "delegate task", rawInput: { action } }),
          turnId,
        ),
      ).toBeUndefined();
    }
    expect(
      state.update(tool({ ...batch.start, title: "delegate task", content: [] }), turnId),
    ).toBeUndefined();
    // Stock controls share the delegate_task title prefix; only spawns name a goal.
    for (const title of ["delegate_task: list", "delegate_task: stop sa-0-test1234"]) {
      const content = [{ type: "content", content: { type: "text", text: "Delegating task" } }];
      expect(state.update(tool({ ...batch.start, title, content }), turnId)).toBeUndefined();
    }
    expect(
      state.update(tool({ ...batch.start, title: "terminal: echo hello" }), turnId),
    ).toBeUndefined();
  });

  it("does not let nested child indices or conflicting identities overwrite direct children", () => {
    const state = new HermesDelegations();
    const start = tool({ ...batch.start, rawInput: batch.args });
    state.update(start, turnId);
    expect(
      state.update(
        progress(start, {
          event: "subagent.start",
          task_index: 0,
          subagent_id: "nested",
          depth: 1,
        }),
        turnId,
      ),
    ).toEqual([]);
    expect(
      state.update(
        progress(start, {
          event: "subagent.start",
          task_index: 0,
          subagent_id: "direct",
          depth: 0,
        }),
        turnId,
      ),
    ).toHaveLength(1);
    expect(
      state.update(
        progress(start, {
          event: "subagent.complete",
          task_index: 0,
          subagent_id: "another",
          depth: 0,
          status: "completed",
        }),
        turnId,
      ),
    ).toEqual([]);
  });

  it("does not reopen a child that finishes before the background dispatch acknowledgement", () => {
    const state = new HermesDelegations();
    const start = tool({ ...dispatched.start, rawInput: dispatched.args });
    state.update(start, turnId);
    state.update(
      progress(start, {
        event: "subagent.complete",
        task_index: 0,
        status: "completed",
        summary: "Fast result",
      }),
      turnId,
    );
    expect(
      state.update(tool({ ...dispatched.complete, rawOutput: dispatched.result }, start), turnId),
    ).toEqual([]);
    expect(
      state.update(
        progress(start, { event: "subagent.text", task_index: 0, text: "Late" }),
        TurnId.make("next-turn"),
      ),
    ).toEqual([]);
  });

  it("settles missing/truncated stock child results without inventing success", () => {
    const state = new HermesDelegations();
    const start = tool(batch.start);
    state.update(start, turnId);
    const events = state.update(tool({ ...batch.complete, content: [] }, start), turnId)!;
    expect(
      events
        .filter((event) => event.type === "task.completed")
        .map((event) => event.payload.status),
    ).toEqual(["stopped", "stopped"]);
  });

  it("accepts Hermes JSON-string task arrays", () => {
    const state = new HermesDelegations();
    const events = state.update(
      tool({
        ...batch.start,
        title: "delegate task",
        content: [],
        rawInput: { tasks: JSON.stringify(batch.args.tasks) },
      }),
      turnId,
    )!;
    expect(
      events.filter((event) => event.type === "task.started").map((event) => event.payload.title),
    ).toEqual(["Inspect routing", "Run tests"]);
  });

  it("recognizes a stock background dispatch even when its goals were clipped", () => {
    const state = new HermesDelegations();
    const start = tool(dispatched.start);
    state.update(start, turnId);
    const events = state.update(
      tool(
        {
          ...dispatched.complete,
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: '{"status": "dispatched", "mode": "background", "goals": ["clipped...',
              },
            },
          ],
        },
        start,
      ),
      turnId,
    )!;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "task.progress", payload: { status: "idle" } });
  });

  it("keeps detached children after parent cancellation but interrupts them on connection loss", () => {
    const state = new HermesDelegations();
    const start = tool({ ...dispatched.start, rawInput: dispatched.args });
    state.update(start, turnId);
    state.update(tool({ ...dispatched.complete, rawOutput: dispatched.result }, start), turnId);
    expect(state.finish("cancelled", undefined, { turnId, preserveBackground: true })).toEqual([]);
    expect(state.finish("interrupted", "ACP disconnected")).toMatchObject([
      {
        type: "task.updated",
        turnId,
        payload: { status: "interrupted", error: "ACP disconnected" },
      },
    ]);
  });

  it("maps registry-stalled results to failure", () => {
    const state = new HermesDelegations();
    const start = tool({ ...dispatched.start, rawInput: dispatched.args });
    state.update(start, turnId);
    expect(
      state.update(
        progress(start, {
          event: "subagent.complete",
          task_index: 0,
          status: "stalled",
          error: "No heartbeat",
        }),
        turnId,
      ),
    ).toMatchObject([
      { type: "task.updated", payload: { status: "failed", error: "No heartbeat" } },
      { type: "task.completed", payload: { status: "failed" } },
    ]);
  });

  it("does not reactivate sidebar liveness after a terminal child result", () => {
    const state = new HermesDelegations();
    const liveness = ThreadBackgroundLiveness.make();
    const apply = (events: NonNullable<ReturnType<HermesDelegations["update"]>>) => {
      for (const event of events) {
        const kind =
          event.type === "task.started"
            ? "started"
            : event.type === "task.completed"
              ? "completed"
              : event.type === "task.progress"
                ? "progress"
                : "updated";
        liveness.recordTaskLiveness({
          threadId: "thread",
          taskId: event.payload.taskId,
          taskType: event.payload.taskType,
          status: "status" in event.payload ? event.payload.status : undefined,
          kind,
        });
      }
    };
    const start = tool({ ...dispatched.start, rawInput: dispatched.args });
    apply(state.update(start, turnId)!);
    apply(
      state.update(tool({ ...dispatched.complete, rawOutput: dispatched.result }, start), turnId)!,
    );
    expect(liveness.getThreadBackgroundLiveness("thread")).toBe("working");
    apply(
      state.update(
        progress(start, { event: "subagent.complete", task_index: 0, status: "completed" }),
      )!,
    );
    expect(liveness.getThreadBackgroundLiveness("thread")).toBeNull();
    apply(
      state.update(
        progress(start, { event: "subagent.text", task_index: 0, text: "Late chunk" }),
        TurnId.make("new-turn"),
      )!,
    );
    expect(liveness.getThreadBackgroundLiveness("thread")).toBeNull();
  });

  it("folds actual ingestion activities into client RuntimeSubagents", () => {
    const state = new HermesDelegations();
    const start = tool(batch.start);
    const started = state.update(start, turnId)!;
    const ended = state.update(tool(batch.complete, start), turnId)!;
    const activities = [...started, ...ended].flatMap((event, index) =>
      runtimeEventToActivities({
        ...event,
        eventId: EventId.make(`hermes-${index}`),
        createdAt: `2026-09-29T12:00:${String(index).padStart(2, "0")}.000Z`,
        provider: ProviderDriverKind.make("hermes"),
        threadId: ThreadId.make("thread"),
      }),
    );
    const persisted = [...new Map(activities.map((activity) => [activity.id, activity])).values()];
    expect(foldSubagentActivities(persisted)).toMatchObject([
      {
        id: "tc-fixture-batch:task:0",
        kind: "subagent",
        title: "Inspect routing",
        status: "completed",
        model: "test/researcher",
        role: "orchestrator",
        result: "Routing inspected.",
        usage: { durationMs: 1500 },
      },
      {
        id: "tc-fixture-batch:task:1",
        title: "Run tests",
        status: "failed",
        model: "test/tester",
        role: "leaf",
        error: "Test process failed.",
        usage: { durationMs: 2000 },
      },
    ]);
  });
});
