import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HermesSettings } from "@t3tools/contracts";

import { HERMES_BUILT_IN_SLASH_COMMANDS } from "../acp/HermesAcpSupport.ts";
import { buildInitialHermesProviderSnapshot, checkHermesProviderStatus } from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const encodeJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A stand-in for `hermes` that answers `--version` and speaks just enough ACP
 * on `acp` to complete the probe handshake: `initialize`, `authenticate`,
 * `session/new`, and then the `available_commands_update` notification Hermes
 * schedules right after the session response (see `acp_adapter/server.py`).
 */
const writeFakeHermesAcpBinary = Effect.fn("writeFakeHermesAcpBinary")(function* (options: {
  readonly prefix: string;
  readonly holdSession?: boolean;
  readonly failAt?: "initialize" | "authenticate";
  readonly availableModels: ReadonlyArray<{ readonly modelId: string; readonly name: string }>;
  readonly availableCommands?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly input?: { readonly hint: string };
  }>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: options.prefix });
  const hermesPath = path.join(dir, "hermes");
  const script = `#!/usr/bin/env node
const models = ${encodeJsonString(options.availableModels)};
const commands = ${encodeJsonString(options.availableCommands ?? null)};
const holdSession = ${encodeJsonString(options.holdSession ?? false)};
const failAt = ${encodeJsonString(options.failAt ?? null)};
let releaseSession;
if (process.argv[2] !== "acp") {
  process.stdout.write("hermes 0.20.0\\n");
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "fixture/release") {
      releaseSession?.();
      continue;
    }
    if (request.id === undefined) continue;
    if (request.method === failAt) {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "fixture-secret-auth-error" } });
      continue;
    }
    if (request.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      });
    } else if (request.method === "authenticate") {
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    } else if (request.method === "session/new") {
      const reply = () => {
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            sessionId: "fake-session",
            models:
              models.length > 0
                ? { currentModelId: models[0].modelId, availableModels: models }
                : undefined,
          },
        });
        if (commands) {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "fake-session",
              update: { sessionUpdate: "available_commands_update", availableCommands: commands },
            },
          });
        }
      };
      if (holdSession) {
        releaseSession = reply;
        process.stderr.write("T3_FIXTURE_SESSION_WAIT\\n");
      } else {
        reply();
      }
    } else {
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    }
  }
});
`;
  yield* fs.writeFileString(hermesPath, script);
  yield* fs.chmod(hermesPath, 0o755);
  return hermesPath;
});

describe("buildInitialHermesProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(decodeHermesSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.reportsContextWindow).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot once enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Hermes");
    }),
  );
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkHermesProviderStatus(
        decodeHermesSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/hermes-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("keeps CLI stderr out of the snapshot when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken hermes install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-version-" });
          const hermesPath = path.join(dir, "hermes");
          yield* fs.writeFileString(
            hermesPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(hermesPath, 0o755);

          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Hermes CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("falls back to the placeholder model when ACP discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-success-" });
          const hermesPath = path.join(dir, "hermes");
          yield* fs.writeFileString(
            hermesPath,
            ["#!/bin/sh", 'printf "hermes 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(hermesPath, 0o755);

          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["hermes-4"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});

// it.live: these spawn a real child process and the probe's bounded wait for
// Hermes's command advertisement uses the clock. Under it.effect's TestClock
// that timer freezes and the probe never returns.
it.live("reports authenticated with derived upstreams once ACP returns models", () =>
  Effect.gen(function* () {
    const snapshot = yield* Effect.scoped(
      Effect.gen(function* () {
        const hermesPath = yield* writeFakeHermesAcpBinary({
          prefix: "t3code-hermes-auth-",
          availableModels: [
            { modelId: "anthropic/claude-opus-4", name: "Claude Opus 4" },
            { modelId: "openai/gpt-5", name: "GPT-5" },
            { modelId: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
          ],
        });
        return yield* checkHermesProviderStatus(
          decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
        );
      }),
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.reportsContextWindow).toBe(true);
    expect(snapshot.auth.status).toBe("authenticated");
    // Derived from model slug prefixes, never from ~/.hermes/.env.
    expect(snapshot.auth.label).toBe("Anthropic, OpenAI");
    expect(snapshot.models.map((model) => model.slug)).toEqual([
      "anthropic/claude-opus-4",
      "openai/gpt-5",
      "anthropic/claude-sonnet-4",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports unauthenticated when the handshake works but no models are configured", () =>
  Effect.gen(function* () {
    const snapshot = yield* Effect.scoped(
      Effect.gen(function* () {
        const hermesPath = yield* writeFakeHermesAcpBinary({
          prefix: "t3code-hermes-noauth-",
          availableModels: [],
        });
        return yield* checkHermesProviderStatus(
          decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
        );
      }),
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.reportsContextWindow).toBe(true);
    expect(snapshot.auth.status).toBe("unauthenticated");
    expect(snapshot.message).toContain("no models");
    expect(snapshot.models.map((model) => model.slug)).toEqual(["hermes-4"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("seeds the built-in slash commands when Hermes advertises none", () =>
  Effect.gen(function* () {
    const snapshot = yield* Effect.scoped(
      Effect.gen(function* () {
        const hermesPath = yield* writeFakeHermesAcpBinary({
          prefix: "t3code-hermes-seed-",
          availableModels: [{ modelId: "anthropic/claude-opus-4", name: "Claude Opus 4" }],
        });
        return yield* checkHermesProviderStatus(
          decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
        );
      }),
    );

    // `compact` leads so the composer offers T3 Code's manual compaction.
    expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
      "compact",
      ...HERMES_BUILT_IN_SLASH_COMMANDS.map((command) => command.name),
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replaces the seed with the commands Hermes advertises", () =>
  Effect.gen(function* () {
    const snapshot = yield* Effect.scoped(
      Effect.gen(function* () {
        const hermesPath = yield* writeFakeHermesAcpBinary({
          prefix: "t3code-hermes-dynamic-",
          availableModels: [{ modelId: "anthropic/claude-opus-4", name: "Claude Opus 4" }],
          availableCommands: [
            { name: "compress", description: "Compress conversation context" },
            { name: "brand-new", description: "A command the seed does not know about" },
          ],
        });
        return yield* checkHermesProviderStatus(
          decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          process.env,
          // Generous so this asserts on the advertisement arriving, not on
          // beating the production deadline under parallel test load.
          { commandAdvertisementTimeoutMs: 30_000 },
        );
      }),
    );

    expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
      "compact",
      "compress",
      "brand-new",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** Observe a real child reaching session/new before advancing the virtual clock. */
const observePendingSession = Effect.fn("observePendingSession")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pending = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
  const observedSpawner = ChildProcessSpawner.make((command) =>
    spawner.spawn(command).pipe(
      Effect.map((child) => {
        let stderr = "";
        return ChildProcessSpawner.makeHandle({
          ...child,
          stderr: child.stderr.pipe(
            Stream.tap((chunk) => {
              stderr += new TextDecoder().decode(chunk);
              return stderr.includes("T3_FIXTURE_SESSION_WAIT")
                ? Deferred.succeed(pending, child)
                : Effect.void;
            }),
          ),
        });
      }),
    ),
  );
  return { pending, spawner: observedSpawner };
});

it.effect("accepts a valid cold ACP startup that takes 20 seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hermesPath = yield* writeFakeHermesAcpBinary({
        prefix: "t3code-hermes-slow-",
        holdSession: true,
        availableModels: [{ modelId: "openai/test-model", name: "Test Model" }],
        availableCommands: [],
      });
      const observed = yield* observePendingSession();
      const probe = yield* checkHermesProviderStatus(
        decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed.spawner),
        Effect.forkScoped,
      );
      const child = yield* Deferred.await(observed.pending);
      yield* TestClock.adjust("20 seconds");
      yield* Stream.make(
        new TextEncoder().encode('{"jsonrpc":"2.0","method":"fixture/release"}\n'),
      ).pipe(Stream.run(child.stdin));
      const snapshot = yield* Fiber.join(probe);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["openai/test-model"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("bounds an unresponsive ACP startup at 60 seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hermesPath = yield* writeFakeHermesAcpBinary({
        prefix: "t3code-hermes-stalled-",
        holdSession: true,
        availableModels: [],
        availableCommands: [],
      });
      const observed = yield* observePendingSession();
      const probe = yield* checkHermesProviderStatus(
        decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed.spawner),
        Effect.forkScoped,
      );
      const child = yield* Deferred.await(observed.pending);
      yield* TestClock.adjust("59 seconds");
      expect(yield* child.isRunning).toBe(true);
      yield* TestClock.adjust("1 second");
      const snapshot = yield* Fiber.join(probe);
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toBe(
        "Hermes CLI is installed but ACP startup timed out after 60000ms.",
      );
      expect(yield* child.isRunning).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const failAt of ["initialize", "authenticate"] as const) {
  it.live(`keeps explicit ACP ${failAt} errors distinct from startup timeout`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hermesPath = yield* writeFakeHermesAcpBinary({
          prefix: "t3code-hermes-failed-",
          failAt,
          availableModels: [],
          availableCommands: [],
        });
        const snapshot = yield* checkHermesProviderStatus(
          decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
        );
        expect(snapshot.status).toBe("error");
        expect(snapshot.installed).toBe(true);
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.message).toBe(
          "Hermes CLI is installed but ACP startup failed. Check server logs for details.",
        );
        expect(snapshot.message).not.toContain("fixture-secret-auth-error");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}
