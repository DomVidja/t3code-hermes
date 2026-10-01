/**
 * Turns a Hermes background run's stored messages into thread commands.
 *
 * Every command id is derived from the run and the Hermes row it came from, so
 * replaying rows the engine has already seen is a no-op (command receipts make
 * dispatch exactly-once). That is what lets the watcher keep its cursors in
 * memory: after a restart it replays a live run from the start and only the
 * rows it had not yet mirrored land.
 *
 * Tool rows go through the same ACP tool-call model and activity mapping as a
 * live Hermes session, so a run reads exactly like a thread started in T3.
 *
 * @module hermesRunTranscript
 */
import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { runtimeEventToActivities } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { makeAcpToolCallEvent } from "../provider/acp/AcpCoreRuntimeEvents.ts";
import { makeToolCallState } from "../provider/acp/AcpRuntimeModel.ts";
import type { HermesMessageRow } from "./hermesRunState.ts";

const HERMES = ProviderDriverKind.make("hermes");

/** Longest message text mirrored. A webhook prompt can embed a whole payload. */
const MAX_MESSAGE_CHARS = 20_000;
/** Longest tool result mirrored, matching what live ACP tool calls keep. */
const MAX_TOOL_RESULT_CHARS = 8_000;
/** Longest final report carried into a reply's primer. */
const MAX_PRIMER_REPORT_CHARS = 4_000;

/** Hermes's final answer when a run has nothing to report. */
const SILENT_MARKER = "[SILENT]";

export interface HermesRunIds {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  /** `hermes-run:<profile>:<rootSessionId>`, the prefix of every derived id. */
  readonly prefix: string;
}

export interface HermesToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

// Port of Hermes's `TOOL_KIND_MAP` (acp_adapter/tools.py).
const TOOL_KINDS: Record<string, "read" | "edit" | "search" | "execute" | "fetch" | "think"> = {
  read_file: "read",
  skill_view: "read",
  skills_list: "read",
  browser_snapshot: "read",
  browser_vision: "read",
  browser_get_images: "read",
  vision_analyze: "read",
  write_file: "edit",
  patch: "edit",
  skill_manage: "edit",
  search_files: "search",
  terminal: "execute",
  process: "execute",
  execute_code: "execute",
  browser_click: "execute",
  browser_type: "execute",
  browser_scroll: "execute",
  browser_press: "execute",
  browser_back: "execute",
  delegate_task: "execute",
  image_generate: "execute",
  text_to_speech: "execute",
  web_search: "fetch",
  web_extract: "fetch",
  browser_navigate: "fetch",
  _thinking: "think",
};

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function arg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Port of the common cases of Hermes's `build_tool_title`. */
function toolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "terminal":
      return `terminal: ${clip(arg(args, "command"), 80)}`;
    case "read_file":
      return `read: ${arg(args, "path") || "?"}`;
    case "write_file":
      return `write: ${arg(args, "path") || "?"}`;
    case "patch":
      return `patch (${arg(args, "mode") || "replace"}): ${arg(args, "path") || "?"}`;
    case "search_files":
      return `search: ${arg(args, "pattern") || "?"}`;
    case "web_search":
      return `web search: ${arg(args, "query") || "?"}`;
    case "session_search":
      return arg(args, "query") ? `session search: ${arg(args, "query")}` : "recent sessions";
    case "delegate_task":
      return arg(args, "goal") ? `delegate: ${clip(arg(args, "goal"), 60)}` : "delegate task";
    case "execute_code": {
      const firstLine = arg(args, "code")
        .split("\n")
        .find((line) => line.trim());
      return firstLine ? `python: ${clip(firstLine.trim(), 70)}` : "python code";
    }
    case "skill_view":
      return `skill view (${arg(args, "name") || "?"})`;
    case "browser_navigate":
      return `navigate: ${arg(args, "url") || "?"}`;
    default:
      return name;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Port of Hermes's `_tool_result_failed` for structured results. */
function toolResultFailed(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (result["success"] === false || result["ok"] === false) return true;
  const exitCode = result["exit_code"];
  if (typeof exitCode === "number" && exitCode !== 0) return true;
  return Boolean(result["error"]) && !result["content"] && !result["output"];
}

/**
 * One tool call as a thread activity. `result` is undefined while the call is
 * still running, which renders as an in-progress row.
 */
function hermesToolActivity(input: {
  readonly ids: HermesRunIds;
  readonly toolCallId: string;
  readonly call: HermesToolCall;
  readonly result: string | undefined;
  readonly createdAt: string;
}): OrchestrationThreadActivity | undefined {
  const { call, result } = input;
  const structured = result === undefined ? undefined : parseJson(result);
  const status =
    result === undefined ? "in_progress" : toolResultFailed(structured) ? "failed" : "completed";
  // Only the usual `{output, exit_code}` shape becomes terminal output; a bare
  // `{error}` falls through to content so its text stays visible.
  const terminalOutput =
    call.name === "terminal" &&
    isRecord(structured) &&
    (typeof structured["output"] === "string" || typeof structured["exit_code"] === "number")
      ? {
          ...(typeof structured["output"] === "string"
            ? { stdout: clip(structured["output"], MAX_TOOL_RESULT_CHARS) }
            : {}),
          ...(typeof structured["exit_code"] === "number"
            ? { exitCode: structured["exit_code"] }
            : {}),
        }
      : undefined;
  const state = makeToolCallState({
    toolCallId: input.toolCallId,
    title: toolTitle(call.name, call.args),
    kind: TOOL_KINDS[call.name] ?? "other",
    status,
    rawInput: call.args,
    ...(terminalOutput !== undefined
      ? { rawOutput: terminalOutput }
      : result !== undefined && result.trim()
        ? {
            content: [
              {
                type: "content" as const,
                content: { type: "text" as const, text: clip(result, MAX_TOOL_RESULT_CHARS) },
              },
            ],
          }
        : {}),
  });
  if (state === undefined) return undefined;
  const phase = result === undefined ? "start" : "end";
  const event = makeAcpToolCallEvent({
    stamp: {
      eventId: EventId.make(`${input.ids.prefix}:tool:${input.toolCallId}:${phase}`),
      createdAt: input.createdAt,
    },
    provider: HERMES,
    threadId: input.ids.threadId,
    turnId: input.ids.turnId,
    toolCall: state,
    rawPayload: null,
  });
  return runtimeEventToActivities(event)[0];
}

/** The tool calls an assistant row asked for, in OpenAI's `tool_calls` shape. */
function parseHermesToolCalls(
  toolCalls: string | null,
): ReadonlyArray<{ readonly id: string } & HermesToolCall> {
  const parsed = toolCalls === null ? undefined : parseJson(toolCalls);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || !entry["id"].trim()) return [];
    const fn = isRecord(entry["function"]) ? entry["function"] : {};
    const name = typeof fn["name"] === "string" && fn["name"].trim() ? fn["name"].trim() : "tool";
    const rawArgs = fn["arguments"];
    const args = typeof rawArgs === "string" ? parseJson(rawArgs) : rawArgs;
    return [{ id: entry["id"].trim(), name, args: isRecord(args) ? args : {} }];
  });
}

/** Hermes stores Unix seconds as REAL; the read model wants ISO strings. */
export function isoFromSeconds(value: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Math.round(value * 1000)));
}

export interface HermesRunBatch {
  readonly commands: OrchestrationCommand[];
  readonly pullRequestUrls: string[];
  /** Newest assistant text in the batch, the run's report once it ends. */
  readonly lastAssistantText: string | null;
}

/**
 * Commands for a batch of rows. `toolCalls` carries calls whose result has not
 * arrived yet across batches, keyed by Hermes's tool call id.
 */
export function hermesRunCommandsFor(
  ids: HermesRunIds,
  rows: readonly HermesMessageRow[],
  toolCalls: Map<string, HermesToolCall>,
): HermesRunBatch {
  const commands: OrchestrationCommand[] = [];
  const pullRequestUrls = new Set<string>();
  let lastAssistantText: string | null = null;
  const { threadId, turnId, prefix } = ids;
  const commandId = (suffix: string) => CommandId.make(`${prefix}:${suffix}`);
  for (const row of rows) {
    const createdAt = isoFromSeconds(row.timestamp);
    const text = clip(row.content.trim(), MAX_MESSAGE_CHARS);
    if (row.role === "user" && text) {
      commands.push({
        type: "thread.message.user.append",
        commandId: commandId(`m${row.id}`),
        threadId,
        message: { messageId: MessageId.make(`${prefix}:m${row.id}`), text, attachments: [] },
        createdAt,
      });
      continue;
    }
    if (row.role === "assistant") {
      for (const url of pullRequestUrlsIn(row, undefined)) pullRequestUrls.add(url);
      if (text) lastAssistantText = text;
      if (row.reasoning) {
        const messageId = MessageId.make(`${prefix}:r${row.id}`);
        commands.push(
          {
            type: "thread.message.reasoning.delta",
            commandId: commandId(`r${row.id}:delta`),
            threadId,
            messageId,
            delta: clip(row.reasoning, MAX_MESSAGE_CHARS),
            turnId,
            createdAt,
          },
          {
            type: "thread.message.reasoning.complete",
            commandId: commandId(`r${row.id}:complete`),
            threadId,
            messageId,
            turnId,
            createdAt,
          },
        );
      }
      if (text) {
        const messageId = MessageId.make(`${prefix}:m${row.id}`);
        commands.push(
          {
            type: "thread.message.assistant.delta",
            commandId: commandId(`m${row.id}:delta`),
            threadId,
            messageId,
            delta: text,
            turnId,
            createdAt,
          },
          {
            type: "thread.message.assistant.complete",
            commandId: commandId(`m${row.id}:complete`),
            threadId,
            messageId,
            turnId,
            createdAt,
          },
        );
      }
      for (const call of parseHermesToolCalls(row.toolCalls)) {
        toolCalls.set(call.id, call);
        const activity = hermesToolActivity({
          ids,
          toolCallId: call.id,
          call,
          result: undefined,
          createdAt,
        });
        if (activity) {
          commands.push({
            type: "thread.activity.append",
            commandId: commandId(`tool:${call.id}:start`),
            threadId,
            activity,
            createdAt,
          });
        }
      }
      continue;
    }
    if (row.role === "tool" && row.toolCallId) {
      const call = toolCalls.get(row.toolCallId) ?? { name: row.toolName ?? "tool", args: {} };
      toolCalls.delete(row.toolCallId);
      for (const url of pullRequestUrlsIn(row, call)) pullRequestUrls.add(url);
      const activity = hermesToolActivity({
        ids,
        toolCallId: row.toolCallId,
        call,
        result: row.content,
        createdAt,
      });
      if (activity) {
        commands.push({
          type: "thread.activity.append",
          commandId: commandId(`tool:${row.toolCallId}:end`),
          threadId,
          activity,
          createdAt,
        });
      }
    }
  }
  return { commands, pullRequestUrls: [...pullRequestUrls], lastAssistantText };
}

/** A final answer of `[SILENT]` is Hermes's way of saying the run had nothing to report. */
export function isSilentReport(text: string | null): boolean {
  return text !== null && text.trim().startsWith(SILENT_MARKER);
}

// GitHub/Forgejo pulls, GitLab merge requests, Bitbucket and Azure pull requests;
// `parseChangeRequestUrl` decides which of them are real.
const PULL_REQUEST_URL =
  /https?:\/\/[^\s"'<>()[\]`]+(?:\/pulls?\/\d+|\/-\/merge_requests\/\d+|\/pull-requests\/\d+|\/pullrequest\/\d+)/g;

/**
 * Pull request URLs a run worked on: in the agent's own words or the output of `gh pr create`.
 * Read-only commands (`list`, `view`, `status`, ...) print pull requests the run merely looked
 * at, and linking those lets an unrelated merge settle the run's thread. `gh pr merge` prints
 * no URL, and a pull request the run opened was already linked by its `create`.
 */
function pullRequestUrlsIn(row: HermesMessageRow, call: HermesToolCall | undefined): string[] {
  const fromTool =
    row.role === "tool" &&
    call?.name === "terminal" &&
    /\bgh\s+pr\s+create\b/.test(arg(call.args, "command"));
  if (row.role !== "assistant" && !fromTool) return [];
  return [...new Set(row.content.match(PULL_REQUEST_URL) ?? [])];
}

/**
 * Context for the first reply to a finished run. Hermes cannot reopen a
 * webhook or cron session over ACP, so a reply starts a fresh session and this
 * tells the agent what it is continuing and where to look for the rest.
 */
export function buildHermesRunPrimer(input: {
  readonly sourceLabel: string;
  readonly profile: string;
  readonly sessionIds: readonly string[];
  readonly pullRequestUrls: readonly string[];
  readonly finalReport: string | null;
  readonly workspaceRoot: string;
}): string {
  const [root, ...rest] = input.sessionIds;
  const lines = [
    "<hermes_background_run>",
    `This conversation continues a background run of ${input.sourceLabel} (Hermes profile "${input.profile}").`,
    `The run was Hermes session ${root ?? "unknown"}${rest.length > 0 ? `, continued after compression as ${rest.join(", ")}` : ""}. Use session_search with that id to recall anything from it.`,
  ];
  if (input.pullRequestUrls.length > 0) {
    lines.push(`Pull requests from the run: ${input.pullRequestUrls.join(", ")}`);
  }
  if (input.finalReport) {
    lines.push("Its final report was:", clip(input.finalReport.trim(), MAX_PRIMER_REPORT_CHARS));
  }
  lines.push(
    `This session runs in ${input.workspaceRoot}, not in the run's own working directory.`,
    "</hermes_background_run>",
  );
  return lines.join("\n");
}
