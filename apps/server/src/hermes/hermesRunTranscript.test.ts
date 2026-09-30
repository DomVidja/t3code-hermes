import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnId, type OrchestrationCommand } from "@t3tools/contracts";

import type { HermesMessageRow } from "./hermesRunState.ts";
import {
  buildHermesRunPrimer,
  hermesRunCommandsFor,
  isSilentReport,
  type HermesToolCall,
} from "./hermesRunTranscript.ts";

const prefix = "hermes-run:default:s1";
const ids = { threadId: ThreadId.make(prefix), turnId: TurnId.make(prefix), prefix };

const row = (fields: Partial<HermesMessageRow> & Pick<HermesMessageRow, "id" | "role">) => ({
  content: "",
  toolCallId: null,
  toolCalls: null,
  toolName: null,
  reasoning: null,
  timestamp: 1_790_000_000 + fields.id,
  ...fields,
});

const toolCall = (id: string, name: string, args: Record<string, unknown>) =>
  JSON.stringify([{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]);

function activities(commands: readonly OrchestrationCommand[]) {
  return commands.flatMap((command) =>
    command.type === "thread.activity.append" ? [command.activity] : [],
  );
}

describe("hermesRunCommandsFor", () => {
  it("mirrors a run's prompt, tool calls, and report like a live Hermes turn", () => {
    const pending = new Map<string, HermesToolCall>();
    const batch = hermesRunCommandsFor(
      ids,
      [
        row({ id: 1, role: "user", content: "Resolve the upstream conflict" }),
        row({
          id: 2,
          role: "assistant",
          toolCalls: toolCall("call-1", "terminal", { command: "gh pr create --fill" }),
        }),
      ],
      pending,
    );
    expect(batch.commands.map((command) => command.type)).toEqual([
      "thread.message.user.append",
      "thread.activity.append",
    ]);
    expect(activities(batch.commands)[0]).toMatchObject({
      kind: "tool.updated",
      payload: { toolCallId: "call-1", status: "inProgress" },
    });

    // The result lands in a later poll; the pending call carries across.
    const next = hermesRunCommandsFor(
      ids,
      [
        row({
          id: 3,
          role: "tool",
          toolCallId: "call-1",
          toolName: "terminal",
          content: JSON.stringify({
            output: "https://github.com/NateWeav/t3code-hermes/pull/72\n",
            exit_code: 0,
          }),
        }),
        row({ id: 4, role: "assistant", content: "Opened the resolution PR and CI is green." }),
      ],
      pending,
    );
    expect(activities(next.commands)[0]).toMatchObject({
      id: `${prefix}:tool:call-1:end`,
      kind: "tool.completed",
      payload: {
        status: "completed",
        data: { rawOutput: { stdout: "https://github.com/NateWeav/t3code-hermes/pull/72\n" } },
      },
    });
    expect(next.pullRequestUrls).toEqual(["https://github.com/NateWeav/t3code-hermes/pull/72"]);
    expect(next.lastAssistantText).toBe("Opened the resolution PR and CI is green.");
    expect(pending.size).toBe(0);
  });

  it("marks a failed command as failed", () => {
    const pending = new Map<string, HermesToolCall>([
      ["call-2", { name: "terminal", args: { command: "vp test" } }],
    ]);
    const batch = hermesRunCommandsFor(
      ids,
      [
        row({
          id: 5,
          role: "tool",
          toolCallId: "call-2",
          content: JSON.stringify({ output: "1 failed", exit_code: 1 }),
        }),
      ],
      pending,
    );
    expect(activities(batch.commands)[0]).toMatchObject({ payload: { status: "failed" } });
  });

  it("ignores pull request URLs a run only read about", () => {
    const pending = new Map<string, HermesToolCall>([
      ["call-3", { name: "web_extract", args: { urls: ["https://github.com/o/r/pull/1"] } }],
    ]);
    const batch = hermesRunCommandsFor(
      ids,
      [
        row({
          id: 6,
          role: "tool",
          toolCallId: "call-3",
          content: "https://github.com/o/r/pull/1",
        }),
      ],
      pending,
    );
    expect(batch.pullRequestUrls).toEqual([]);
  });

  it("derives the same ids on replay, so re-reading rows is a no-op for the engine", () => {
    const rows = [row({ id: 7, role: "assistant", content: "hello" })];
    const first = hermesRunCommandsFor(ids, rows, new Map());
    const second = hermesRunCommandsFor(ids, rows, new Map());
    expect(second.commands.map((command) => command.commandId)).toEqual(
      first.commands.map((command) => command.commandId),
    );
  });
});

describe("isSilentReport", () => {
  it("recognises Hermes's nothing-to-report answer", () => {
    expect(isSilentReport("[SILENT]")).toBe(true);
    expect(isSilentReport("  [SILENT] nothing to do")).toBe(true);
    expect(isSilentReport("Merged the PR")).toBe(false);
    expect(isSilentReport(null)).toBe(false);
  });
});

describe("buildHermesRunPrimer", () => {
  it("names the run's sessions, pull requests, report, and where the reply runs", () => {
    const primer = buildHermesRunPrimer({
      sourceLabel: "webhook/upstream-sync",
      profile: "upstream-sync",
      sessionIds: ["root", "tip"],
      pullRequestUrls: ["https://github.com/NateWeav/t3code-hermes/pull/72"],
      finalReport: "Blocked: ChatComposer.tsx needs a human call.",
      workspaceRoot: "/w/t3code-hermes",
    });
    expect(primer).toContain("Hermes session root, continued after compression as tip");
    expect(primer).toContain("https://github.com/NateWeav/t3code-hermes/pull/72");
    expect(primer).toContain("Blocked: ChatComposer.tsx needs a human call.");
    expect(primer).toContain("This session runs in /w/t3code-hermes");
  });
});
