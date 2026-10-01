import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  hermesSessionInfoIndicatesCompaction,
  HERMES_BUILT_IN_SLASH_COMMANDS,
  resolveHermesAcpBaseModelId,
  isHermesDerivedTitle,
  normalizeHermesTerminalResult,
  resolveHermesSessionModeId,
} from "./HermesAcpSupport.ts";
import { projectActivityPayload } from "../../orchestration/ActivityPayloadProjection.ts";

describe("resolveHermesAcpBaseModelId", () => {
  it("falls back to the placeholder model for empty ids", () => {
    expect(resolveHermesAcpBaseModelId(undefined)).toBe("hermes-4");
    expect(resolveHermesAcpBaseModelId("   ")).toBe("hermes-4");
  });

  it("passes provider-owned model ids through untouched", () => {
    expect(resolveHermesAcpBaseModelId("  openai/gpt-5  ")).toBe("openai/gpt-5");
    expect(resolveHermesAcpBaseModelId("NousResearch/Hermes-4-405B")).toBe(
      "NousResearch/Hermes-4-405B",
    );
  });
});

describe("buildHermesAcpSpawnInput", () => {
  it("launches the ACP stdio server and forwards the environment untouched", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/usr/local/bin/hermes" },
      "/tmp/project",
      {
        HERMES_HOME: "/home/dev/.hermes",
      },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HERMES_HOME: "/home/dev/.hermes" },
    });
  });

  it("defaults to `hermes` on PATH and omits env when none is supplied", () => {
    expect(buildHermesAcpSpawnInput(null, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("isHermesDerivedTitle", () => {
  // Observed from Hermes 0.21.0: the instant title, then the model's title.
  const prompt =
    "Do not run any tools or commands. In your head: is 391 prime? Answer yes or no with one short sentence.";

  it("recognises the instant title Hermes cuts from the prompt", () => {
    expect(isHermesDerivedTitle("Do not run any tools or commands. In your head…", [prompt])).toBe(
      true,
    );
    expect(isHermesDerivedTitle("fix the  bug", ["fix the bug\nin the parser"])).toBe(true);
  });

  it("still recognises it after a steer lands before the title does", () => {
    expect(
      isHermesDerivedTitle("Do not run any tools or commands. In your head…", [
        prompt,
        "actually, also check 397",
      ]),
    ).toBe(true);
  });

  it("keeps a model-written title", () => {
    expect(isHermesDerivedTitle("Check if 391 is prime", [prompt])).toBe(false);
    expect(isHermesDerivedTitle("Check if 391 is prime", [])).toBe(false);
  });
});

describe("resolveHermesSessionModeId", () => {
  const modeState = {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask", description: "Confirm every edit" },
      { id: "auto", name: "Auto", description: "Apply edits without asking" },
    ],
  };

  it("selects the autonomous mode for permissive runtime modes", () => {
    expect(resolveHermesSessionModeId({ runtimeMode: "full-access", modeState })).toBe("auto");
    expect(resolveHermesSessionModeId({ runtimeMode: "auto-accept-edits", modeState })).toBe(
      "auto",
    );
  });

  it("maps each runtime mode onto Hermes's edit-approval modes", () => {
    const hermesModeState = {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default", description: "Ask before edits." },
        {
          id: "accept_edits",
          name: "Accept Edits",
          description: "Auto-allow workspace and /tmp edits; still asks for sensitive paths.",
        },
        {
          id: "dont_ask",
          name: "Don't Ask",
          description: "Auto-allow file edits for this session except sensitive paths.",
        },
      ],
    };
    expect(
      resolveHermesSessionModeId({ runtimeMode: "full-access", modeState: hermesModeState }),
    ).toBe("dont_ask");
    expect(resolveHermesSessionModeId({ runtimeMode: "auto", modeState: hermesModeState })).toBe(
      "dont_ask",
    );
    expect(
      resolveHermesSessionModeId({ runtimeMode: "auto-accept-edits", modeState: hermesModeState }),
    ).toBe("accept_edits");
    expect(
      resolveHermesSessionModeId({ runtimeMode: "approval-required", modeState: hermesModeState }),
    ).toBeUndefined();
  });

  it("stays put when the requested mode is already active", () => {
    expect(
      resolveHermesSessionModeId({ runtimeMode: "approval-required", modeState }),
    ).toBeUndefined();
  });

  it("returns nothing when the agent advertises no usable modes", () => {
    expect(
      resolveHermesSessionModeId({ runtimeMode: "full-access", modeState: undefined }),
    ).toBeUndefined();
    expect(
      resolveHermesSessionModeId({
        runtimeMode: "full-access",
        modeState: { currentModeId: "only", availableModes: [] },
      }),
    ).toBeUndefined();
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "hermes-4",
        requestedModelId: "openai/gpt-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["openai/gpt-5"]);
      expect(result).toBe("openai/gpt-5");
    }),
  );

  it.effect("keeps the profile's model when asked for the bare placeholder", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "cliproxyapi:claude-opus-5-5",
        requestedModelId: "hermes-4",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("cliproxyapi:claude-opus-5-5");
    }),
  );

  it.effect("keeps the running model when asked for it without its provider", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "custom:cliproxyapi:claude-opus-5-5",
        requestedModelId: "claude-opus-5-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("custom:cliproxyapi:claude-opus-5-5");
    }),
  );

  it.effect("switches when a provider-qualified request only shares the running model's tail", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "custom:cliproxyapi:gpt-6-astra",
        requestedModelId: "cliproxyapi:gpt-6-astra",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["cliproxyapi:gpt-6-astra"]);
      expect(result).toBe("cliproxyapi:gpt-6-astra");
    }),
  );

  it.effect("skips set_model when requested matches current or is absent", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "hermes-4",
          requestedModelId: "hermes-4",
          mapError: (cause) => cause.message,
        }),
      ).toBe("hermes-4");
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "hermes-4",
          requestedModelId: undefined,
          mapError: (cause) => cause.message,
        }),
      ).toBe("hermes-4");
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("re-sends the current model when forceReapply asks for an agent rebuild", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      // Hermes rebuilds the session's agent from config.yaml on every
      // set_session_model, which is the only way a reasoning level reaches a
      // session that is already running.
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openai/gpt-5",
          requestedModelId: "openai/gpt-5",
          forceReapply: true,
          mapError: (cause) => cause.message,
        }),
      ).toBe("openai/gpt-5");
      // No requested model still rebuilds, using whatever the session is on.
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openai/gpt-5",
          requestedModelId: undefined,
          forceReapply: true,
          mapError: (cause) => cause.message,
        }),
      ).toBe("openai/gpt-5");
      expect(modelCalls).toEqual(["openai/gpt-5", "openai/gpt-5"]);
    }),
  );

  it.effect("has nothing to re-send when forceReapply hits a session with no model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: undefined,
          requestedModelId: undefined,
          forceReapply: true,
          mapError: (cause) => cause.message,
        }),
      ).toBeUndefined();
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model id");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "hermes-4",
          requestedModelId: "openai/gpt-5",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("HERMES_BUILT_IN_SLASH_COMMANDS", () => {
  it("mirrors the ACP adapter's advertised command names", () => {
    // Source of truth: `_ADVERTISED_COMMANDS` in hermes-agent's
    // `acp_adapter/server.py`. These are the adapter's commands, not the
    // interactive `hermes` TUI's.
    expect(HERMES_BUILT_IN_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "help",
      "model",
      "tools",
      "context",
      "reset",
      "compress",
      "steer",
      "queue",
      "version",
    ]);
  });

  it("gives every seeded command a description and only hints the ones that take input", () => {
    for (const command of HERMES_BUILT_IN_SLASH_COMMANDS) {
      expect(command.description).toBeTruthy();
    }
    expect(
      HERMES_BUILT_IN_SLASH_COMMANDS.filter((command) => command.input !== undefined).map(
        (command) => command.name,
      ),
    ).toEqual(["model", "steer", "queue"]);
  });
});

describe("hermesSessionInfoIndicatesCompaction", () => {
  it("detects a compression-driven session rotation", () => {
    expect(
      hermesSessionInfoIndicatesCompaction({
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_info_update",
          title: "Long thread",
          _meta: {
            hermes: {
              sessionProvenance: {
                compressionDepth: 2,
                reason: "compression",
                creatorKind: "compression",
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("ignores provenance without a compression reason", () => {
    expect(
      hermesSessionInfoIndicatesCompaction({
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_info_update",
          _meta: { hermes: { sessionProvenance: { compressionDepth: 0 } } },
        },
      }),
    ).toBe(false);
  });

  it("ignores payloads with no Hermes provenance at all", () => {
    expect(hermesSessionInfoIndicatesCompaction(undefined)).toBe(false);
    expect(hermesSessionInfoIndicatesCompaction({ update: { title: "x" } })).toBe(false);
    expect(hermesSessionInfoIndicatesCompaction({ _meta: { hermes: {} } })).toBe(false);
  });
});

describe("normalizeHermesTerminalResult", () => {
  const completedTerminal = (text: string, status: "completed" | "failed" = "completed") => ({
    toolCallId: "tc-1",
    kind: "execute",
    status,
    command: "git status",
    detail: "git status",
    data: {
      toolCallId: "tc-1",
      kind: "execute",
      command: "git status",
      content: [{ type: "content" as const, content: { type: "text" as const, text } }],
    },
  });

  it("moves multi-line terminal output out of Hermes's markdown summary", () => {
    const normalized = normalizeHermesTerminalResult(
      completedTerminal(
        "terminal result\n- **output:** On branch main\n- clean tree\n\nnothing to commit\n- **exit_code:** 0",
      ),
    );
    expect(normalized.data.content).toBeUndefined();
    expect(normalized.data.rawOutput).toEqual({
      stdout: "On branch main\n- clean tree\n\nnothing to commit",
      exitCode: 0,
    });
    expect(normalized.command).toBe("git status");
  });

  it("keeps field-shaped lines that belong to the command's own output", () => {
    const normalized = normalizeHermesTerminalResult(
      completedTerminal(
        [
          "terminal result",
          "- **output:** # Report",
          "- **output:** quoted",
          "- **exit_code:** 1",
          "tail line",
          "- **exit_code:** 0",
          "- **cwd:** /repo",
        ].join("\n"),
      ),
    );
    expect(normalized.data.rawOutput).toEqual({
      stdout: "# Report\n- **output:** quoted\n- **exit_code:** 1\ntail line",
      exitCode: 0,
    });
  });

  it("gives clients the output's first line instead of the summary heading", () => {
    const toolCall = normalizeHermesTerminalResult(
      completedTerminal("terminal result\n- **output:** 391\n- **exit_code:** 0"),
    );
    const projected = projectActivityPayload({
      id: "activity-1" as never,
      createdAt: "2026-09-29T00:00:00.000Z",
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      turnId: null,
      payload: { itemType: "command_execution", status: "completed", data: toolCall.data },
    });
    expect((projected.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "391",
    });
  });

  it("keeps the exit code when a failing command printed nothing", () => {
    const normalized = normalizeHermesTerminalResult(
      completedTerminal("✅ terminal completed\n- **exit_code:** 1", "failed"),
    );
    expect(normalized.data.content).toBeUndefined();
    expect(normalized.data.rawOutput).toEqual({ exitCode: 1 });
  });

  it("leaves failure text, in-flight calls, and other tools untouched", () => {
    const failure = completedTerminal("terminal failed: command timed out", "failed");
    expect(normalizeHermesTerminalResult(failure)).toBe(failure);

    const running = {
      ...completedTerminal("terminal result\n- **output:** x"),
      status: "inProgress" as const,
    };
    expect(normalizeHermesTerminalResult(running)).toBe(running);

    const edit = { ...completedTerminal("terminal result\n- **output:** x"), kind: "edit" };
    expect(normalizeHermesTerminalResult(edit)).toBe(edit);
  });
});
