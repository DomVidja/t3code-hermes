/**
 * Hermes delegate_task is an ordinary ACP tool, not a child session. Stock
 * Hermes suppresses rawInput/rawOutput, even for JSON results: _structured() is
 * only a Markdown formatter. Prefer the carried patch's structured fields;
 * keep the stock formatter fallback here, never in orchestration or clients.
 */
import {
  RuntimeTaskId,
  type TurnId,
  type ProviderRuntimeTaskStartedEvent,
  type ProviderRuntimeTaskProgressEvent,
  type ProviderRuntimeTaskUpdatedEvent,
  type ProviderRuntimeTaskCompletedEvent,
} from "@t3tools/contracts";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

type TaskEvent = (
  | Pick<ProviderRuntimeTaskStartedEvent, "type" | "payload">
  | Pick<ProviderRuntimeTaskProgressEvent, "type" | "payload">
  | Pick<ProviderRuntimeTaskUpdatedEvent, "type" | "payload">
  | Pick<ProviderRuntimeTaskCompletedEvent, "type" | "payload">
) & { readonly turnId?: TurnId };

type Child = {
  readonly index: number;
  title: string;
  role?: string;
  model?: string;
  settled: boolean;
  /** Cancelled with its turn before Hermes acknowledged a background dispatch. */
  awaitingDispatch?: boolean;
  fingerprint?: string;
  providerId?: string;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      return array(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Hermes counts a child's tokens only once it finishes: flat on a live
 * `subagent.complete`, nested under `tokens` in a result entry. Its output
 * count already includes reasoning.
 */
function tokenUsage(result: Record<string, unknown>) {
  const tokens = record(result.tokens);
  const round = (value: number | undefined) =>
    value === undefined ? undefined : Math.round(value);
  const input = round(count(result.input_tokens) ?? count(tokens.input));
  const output = round(count(result.output_tokens) ?? count(tokens.output));
  const reasoning = round(count(result.reasoning_tokens));
  if (input === undefined && output === undefined) return {};
  return {
    totalTokens: (input ?? 0) + (output ?? 0),
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
}

function contentText(tool: AcpToolCallState): string {
  return (Array.isArray(tool.data.content) ? tool.data.content : [])
    .flatMap((item) => {
      const entry = record(item);
      const content = record(entry.content);
      return entry.type === "content" && content.type === "text" ? [text(content.text) ?? ""] : [];
    })
    .join("\n");
}

// Stock titles vary by Hermes version and locale ("delegate: goal", "delegate batch (2 tasks)",
// "delegate_task: 2 tasks: a | b"), and list/steer/stop controls share them. The start content is
// fixed English and names a goal only for spawns ("Delegating task:\n<goal>", "Delegating 2 tasks").
const DELEGATE_TITLE =
  /^(?:delegate_task(?::|$)|delegate task$|delegate: |delegate batch \(\d+ tasks\)$)/;
const SPAWN_CONTENT = /^Delegating (?:task:\n\S|\d+ tasks(?:\n|$))/;

function isHermesDelegation(tool: AcpToolCallState): boolean {
  const args = record(tool.data.rawInput);
  if (args.action !== undefined && args.action !== "spawn") return false;
  if (tool.kind !== "execute" || !DELEGATE_TITLE.test(text(tool.data.title) ?? tool.title ?? ""))
    return false;
  return (
    text(args.goal) !== undefined ||
    array(args.tasks).length > 0 ||
    SPAWN_CONTENT.test(contentText(tool))
  );
}

/** Child lifecycles must not be coalesced across siblings on their parent tool. */
export function isHermesDelegationProgress(tool: AcpToolCallState): boolean {
  return typeof record(record(tool.data.rawOutput).hermesDelegation).event === "string";
}

function startChildren(tool: AcpToolCallState): Child[] {
  const args = record(tool.data.rawInput);
  const batch = array(args.tasks);
  const tasks = batch.length > 0 ? batch : text(args.goal) ? [args] : [];
  if (tasks.length > 0) {
    return tasks.map((task, index) => {
      const input = record(task);
      const role = text(input.role) ?? text(args.role);
      const model = text(input.model) ?? text(args.model);
      return {
        index,
        title: text(input.goal) ?? `Delegated task ${index + 1}`,
        ...(role ? { role } : {}),
        ...(model ? { model } : {}),
        settled: false,
      };
    });
  }
  const content = contentText(tool);
  const batchCount =
    /^Delegating (\d+) tasks/.exec(content)?.[1] ??
    /^delegate batch \((\d+) tasks\)$/.exec(text(tool.data.title) ?? tool.title ?? "")?.[1];
  if (batchCount) {
    // Stock lists only the first eight goals but always states the count. Keep
    // every child, filling omitted metadata from final results. The count is
    // provider text: bound the up-front allocation (as the patch bounds child
    // snapshots); final results still add any child past the bound.
    return Array.from({ length: Math.min(Number(batchCount), 128) }, (_, index) => {
      const line = new RegExp(`^${index + 1}\\. (.*)$`, "m").exec(content)?.[1];
      const roleMatch = line ? /^(.*) \(([^()]+)\)$/.exec(line) : null;
      return {
        index,
        title: roleMatch?.[1] ?? line ?? `Delegated task ${index + 1}`,
        ...(roleMatch?.[2] ? { role: roleMatch[2] } : {}),
        settled: false,
      };
    });
  }
  return [
    {
      index: 0,
      title:
        text(content.replace(/^Delegating task:?\n?/, "")) ??
        text((text(tool.data.title) ?? tool.title)?.replace(/^delegate(?:_task)?: /, "")) ??
        "Delegated task",
      settled: false,
    },
  ];
}

function stockResults(content: string): Record<string, unknown>[] {
  const headers = [...content.matchAll(/^[✅✗⏱⚠•] Task (\d+): (\w+)(?: \(([^\n]*)\))?$/gm)];
  return headers.map((header, index) => {
    const lines = content
      .slice(header.index! + header[0].length, headers[index + 1]?.index ?? content.length)
      .trim()
      .split("\n");
    const errorAt = lines.findIndex((line) => line.startsWith("Error: "));
    const toolsAt = lines.findLastIndex((line) => line.startsWith("Tools: "));
    const end = toolsAt === -1 ? lines.length : toolsAt;
    const bits = header[3]?.split(", ") ?? [];
    const duration = bits.find((bit) => /^\d+(?:\.\d+)?s$/.test(bit));
    return {
      task_index: Number(header[1]) - 1,
      status: header[2],
      model: bits.find((bit) => !bit.startsWith("role=") && !/^\d+(?:\.\d+)?s$/.test(bit)),
      _child_role: bits.find((bit) => bit.startsWith("role="))?.slice(5),
      duration_seconds: duration ? Number(duration.slice(0, -1)) : undefined,
      summary: lines
        .slice(0, errorAt === -1 ? end : errorAt)
        .join("\n")
        .trim(),
      error: errorAt === -1 ? undefined : lines.slice(errorAt, end).join("\n").slice(7).trim(),
    };
  });
}

function terminalStatus(status: unknown) {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "timeout":
    case "stalled":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "stopped";
    default:
      return undefined;
  }
}

/** Keep background children attached to their launch turn, even after that prompt returns. */
export class HermesDelegations {
  private readonly finished = new Set<string>();
  private readonly calls = new Map<
    string,
    { children: Map<number, Child>; turnId: TurnId | undefined; background: boolean; live: boolean }
  >();

  update(tool: AcpToolCallState, turnId?: TurnId): TaskEvent[] | undefined {
    if (this.finished.has(tool.toolCallId)) return [];
    let call = this.calls.get(tool.toolCallId);
    if (!call && isHermesDelegationProgress(tool)) return [];
    if (!call && (!turnId || !isHermesDelegation(tool))) return undefined;
    const events: TaskEvent[] = [];
    if (!call) {
      call = {
        children: new Map(startChildren(tool).map((child) => [child.index, child])),
        turnId,
        background: false,
        live: tool.data.rawInput !== undefined,
      };
      this.calls.set(tool.toolCallId, call);
      for (const child of call.children.values()) {
        events.push({
          type: "task.started",
          payload: { ...this.linkage(tool.toolCallId, child), description: child.title },
        });
        events.push({
          type: "task.progress",
          payload: {
            ...this.linkage(tool.toolCallId, child),
            description: child.title,
            status: "pending",
          },
        });
      }
    }
    const { children } = call;
    const output = record(tool.data.rawOutput);
    const progress = record(output.hermesDelegation);
    if (tool.status === "completed" || tool.status === "failed") {
      const content = contentText(tool);
      // Stock clips fallback JSON at 5,000 characters. The dispatch header
      // precedes the potentially long goals; clipping is not a child failure.
      const dispatched =
        output.status === "dispatched" ||
        record(content).status === "dispatched" ||
        /^\{\s*"status"\s*:\s*"dispatched"\s*,\s*"mode"\s*:\s*"background"/.test(content);
      if (dispatched) {
        call.background = true;
        for (const child of children.values()) {
          // Detached children outlive their parent's cancellation, so the
          // acknowledgement reopens any the cancelled turn settled.
          if (child.settled && !child.awaitingDispatch) continue;
          child.settled = false;
          child.awaitingDispatch = false;
          events.push({
            type: "task.progress",
            payload: {
              ...this.linkage(tool.toolCallId, child),
              description: child.title,
              status: call.live ? "running" : "idle",
              ...(!call.live
                ? {
                    summary:
                      "Dispatched in background; stock Hermes ACP does not report child completion.",
                  }
                : {}),
            },
          });
        }
        if (!call.live || [...children.values()].every((child) => child.settled))
          this.forget(tool.toolCallId);
        return events.map((event) => ({
          ...event,
          ...(call.turnId ? { turnId: call.turnId } : {}),
        }));
      }
      const results = Array.isArray(output.results)
        ? output.results.map(record)
        : stockResults(content);
      const error = text(output.error) ?? /^Delegation failed: ([\s\S]*)$/.exec(content)?.[1];
      for (const result of results) {
        const index = count(result.task_index);
        if (index === undefined || !Number.isInteger(index)) continue;
        let child = children.get(index);
        if (!child) {
          child = {
            index,
            title: text(result.goal) ?? `Delegated task ${index + 1}`,
            settled: false,
          };
          children.set(index, child);
        }
        // A live child already reported its own subagent.complete.
        if (child.settled) continue;
        events.push(...this.complete(tool.toolCallId, child, result));
      }
      for (const child of children.values()) {
        child.awaitingDispatch = false;
        if (child.settled) continue;
        events.push(
          ...this.complete(tool.toolCallId, child, {
            status: error || tool.status === "failed" ? "failed" : "interrupted",
            error: error ?? "Hermes returned without a result for this task.",
          }),
        );
      }
    } else if (typeof progress.event === "string") {
      const index = count(progress.task_index);
      const child = index === undefined ? undefined : children.get(index);
      const providerId = text(progress.subagent_id);
      if (
        child &&
        !child.settled &&
        (count(progress.depth) ?? 0) === 0 &&
        (!child.providerId || !providerId || child.providerId === providerId)
      ) {
        if (providerId) child.providerId = providerId;
        this.metadata(child, progress);
        if (progress.event === "subagent.complete") {
          events.push(...this.complete(tool.toolCallId, child, progress));
        } else {
          const summary = text(progress.text)?.slice(-2000);
          const lastToolName = text(progress.tool);
          const event: TaskEvent = {
            type: "task.progress",
            payload: {
              ...this.linkage(tool.toolCallId, child),
              description: child.title,
              status: progress.event === "subagent.spawn_requested" ? "pending" : "running",
              ...(summary ? { summary } : {}),
              ...(lastToolName ? { lastToolName } : {}),
            },
          };
          const fingerprint = JSON.stringify(event);
          if (fingerprint !== child.fingerprint) {
            child.fingerprint = fingerprint;
            events.push(event);
          }
        }
      }
    }
    if ([...children.values()].every((child) => child.settled && !child.awaitingDispatch))
      this.forget(tool.toolCallId);
    return events.map((event) => ({ ...event, ...(call.turnId ? { turnId: call.turnId } : {}) }));
  }

  finish(
    status: "cancelled" | "failed" | "interrupted",
    error?: string,
    options?: { turnId: TurnId; preserveBackground: boolean },
  ): TaskEvent[] {
    const events: TaskEvent[] = [];
    for (const [id, call] of this.calls) {
      if (
        options &&
        (call.turnId !== options.turnId ||
          (options.preserveBackground &&
            call.background &&
            [...call.children.values()].some((child) => !child.settled)))
      )
        continue;
      // Cancelling a turn can race Hermes's dispatch acknowledgement; keep the
      // call so a late acknowledgement can reopen its still-running children.
      const awaitDispatch = status === "cancelled" && options !== undefined && !call.background;
      for (const child of call.children.values()) {
        if (child.settled) continue;
        events.push({
          type: "task.updated",
          ...(call.turnId ? { turnId: call.turnId } : {}),
          payload: { ...this.linkage(id, child), status, ...(error ? { error } : {}) },
        });
        if (awaitDispatch) {
          child.settled = true;
          child.awaitingDispatch = true;
        }
      }
      if (!awaitDispatch) this.forget(id);
    }
    return events;
  }

  private forget(id: string) {
    this.calls.delete(id);
    this.finished.add(id);
    if (this.finished.size > 256) this.finished.delete(this.finished.values().next().value!);
  }

  private linkage(id: string, child: Child) {
    return {
      taskId: RuntimeTaskId.make(`${id}:task:${child.index}`),
      taskType: "subagent",
      toolUseId: id,
      title: child.title,
      agentIndex: child.index,
      ...(child.role ? { role: child.role } : {}),
      ...(child.model ? { model: child.model } : {}),
    };
  }

  private metadata(child: Child, result: Record<string, unknown>) {
    child.title = text(result.goal) ?? child.title;
    const role = text(result._child_role) ?? text(result.role);
    const model = text(result.model);
    if (role) child.role = role;
    if (model) child.model = model;
  }

  private complete(id: string, child: Child, result: Record<string, unknown>): TaskEvent[] {
    this.metadata(child, result);
    const status = terminalStatus(result.status) ?? "stopped";
    const summary = text(result.summary) ?? text(result.text);
    const error = text(result.error);
    const duration = count(result.duration_seconds);
    const toolUses = Array.isArray(result.tool_trace)
      ? result.tool_trace.length
      : count(result.tool_count);
    const usage = {
      ...tokenUsage(result),
      ...(duration !== undefined ? { durationMs: Math.round(duration * 1000) } : {}),
      ...(toolUses !== undefined ? { toolUses } : {}),
    };
    child.settled = true;
    const events: TaskEvent[] = [];
    if (error)
      events.push({
        type: "task.updated",
        payload: {
          ...this.linkage(id, child),
          status: status === "stopped" ? "interrupted" : status,
          error,
        },
      });
    events.push({
      type: "task.completed",
      payload: {
        ...this.linkage(id, child),
        status,
        ...(summary || error ? { summary: summary ?? error! } : {}),
        ...(Object.keys(usage).length > 0 ? { typedUsage: usage } : {}),
      },
    });
    return events;
  }
}
