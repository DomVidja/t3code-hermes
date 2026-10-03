// @effect-diagnostics nodeBuiltinImport:off - builds fixture git repos synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HermesPatchId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { HERMES_PATCHES } from "./hermesPatches.ts";
import { HermesPatchService, make } from "./HermesPatchService.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

const withService = (hermes: { readonly enabled: boolean; readonly binaryPath?: string }) =>
  Effect.provide(
    Layer.effect(HermesPatchService, make).pipe(
      Layer.provide(ServerSettings.layerTest({ providers: { hermes } })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

/** A git checkout laid out like a source install, with a stand-in binary. */
const makeHermesCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-install-" });
  git(root, "init", "--quiet");
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "hermes\n");
  NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "venv/\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "base");
  const binaryPath = NodePath.join(root, "venv", "bin", "hermes");
  NodeFS.mkdirSync(NodePath.dirname(binaryPath), { recursive: true });
  NodeFS.writeFileSync(binaryPath, "#!/bin/sh\n", { mode: 0o755 });
  return { root, binaryPath };
});

/** Build only the old-side source fixture; no Hermes process or live install is used. */
function seedPatchPreimage(root: string, content: string) {
  const files = new Map<string, string[]>();
  let file: string[] | null = null;
  let position = 0;
  let remaining = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      remaining = 0;
      continue;
    }
    if (line.startsWith("--- a/")) {
      file = [];
      files.set(line.slice(6), file);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (hunk !== null) {
      position = Number(hunk[1]) - 1;
      remaining = Number(hunk[2] ?? 1);
      continue;
    }
    if (file !== null && remaining > 0 && (line.startsWith(" ") || line.startsWith("-"))) {
      file[position++] = line.slice(1);
      remaining--;
    }
  }
  for (const [relative, lines] of files) {
    const target = NodePath.join(root, relative);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, lines.join("\n") + "\n");
  }
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "-m",
    "patch fixture",
  );
}

describe("HermesPatchService", () => {
  it.effect(
    "routes list, apply, remove and retry to the selected checkout without missing/disabled fallback",
    () =>
      Effect.gen(function* () {
        const a = yield* makeHermesCheckout;
        const b = yield* makeHermesCheckout;
        const patch = HERMES_PATCHES[0]!;
        seedPatchPreimage(a.root, patch.content);
        const aid = ProviderInstanceId.make("hermes-a");
        const bid = ProviderInstanceId.make("hermes-b");
        const off = ProviderInstanceId.make("hermes-off");
        yield* Effect.gen(function* () {
          const service = yield* HermesPatchService;
          const state = (instanceId: ProviderInstanceId) =>
            service
              .list({ instanceId })
              .pipe(
                Effect.map(
                  (snapshot) => snapshot.patches.find((entry) => entry.id === patch.id)?.state,
                ),
              );
          assert.deepEqual(
            [yield* state(aid), yield* state(bid), yield* state(aid)],
            ["notApplied", "doesNotApply", "notApplied"],
          );
          assert.equal(
            (yield* Effect.flip(service.apply({ instanceId: bid, patchId: patch.id }))).reason,
            "wrongState",
          );
          const applied = yield* service.apply({ instanceId: aid, patchId: patch.id });
          assert.equal(applied.checkoutPath, NodeFS.realpathSync(a.root));
          assert.equal(yield* state(aid), "applied");
          assert.equal(yield* state(bid), "doesNotApply");
          const removed = yield* service.revert({ instanceId: aid, patchId: patch.id });
          assert.equal(removed.checkoutPath, NodeFS.realpathSync(a.root));
          assert.equal(yield* state(aid), "notApplied");
          assert.equal(
            (yield* Effect.flip(service.revert({ instanceId: bid, patchId: patch.id }))).reason,
            "wrongState",
          );
          for (const instanceId of [off, ProviderInstanceId.make("missing")]) {
            assert.equal((yield* service.list({ instanceId })).availability, "providerDisabled");
            assert.equal(
              (yield* Effect.flip(service.apply({ instanceId, patchId: patch.id }))).reason,
              "unavailable",
            );
            assert.equal(
              (yield* Effect.flip(service.revert({ instanceId, patchId: patch.id }))).reason,
              "unavailable",
            );
          }
          assert.equal(git(a.root, "status", "--porcelain"), "");
          assert.equal(git(b.root, "status", "--porcelain"), "");
        }).pipe(
          Effect.provide(
            Layer.effect(HermesPatchService, make).pipe(
              Layer.provide(
                ServerSettings.layerTest({
                  providerInstances: {
                    [aid]: {
                      driver: ProviderDriverKind.make("hermes"),
                      enabled: true,
                      config: { binaryPath: a.binaryPath },
                    },
                    [bid]: {
                      driver: ProviderDriverKind.make("hermes"),
                      enabled: true,
                      config: { binaryPath: b.binaryPath },
                    },
                    [off]: {
                      driver: ProviderDriverKind.make("hermes"),
                      enabled: false,
                      config: { binaryPath: b.binaryPath },
                    },
                  },
                }),
              ),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says Hermes is disabled rather than failing", () =>
    Effect.gen(function* () {
      const service = yield* HermesPatchService;
      const snapshot = yield* service.list({});
      assert.strictEqual(snapshot.availability, "providerDisabled");
      assert.deepStrictEqual(snapshot.patches, []);
      const error = yield* Effect.flip(service.apply({ patchId: HERMES_PATCHES[0]!.id }));
      assert.strictEqual(error.reason, "unavailable");
    }).pipe(withService({ enabled: false })),
  );

  it.effect("reads the enabled Hermes's checkout and refuses changes that do not fit", () =>
    Effect.gen(function* () {
      const { root, binaryPath } = yield* makeHermesCheckout;
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        const snapshot = yield* service.list({});
        assert.strictEqual(snapshot.availability, "ready");
        assert.strictEqual(snapshot.checkoutPath, NodeFS.realpathSync(root));
        assert.isFalse(snapshot.detachedHead);
        // The shipped patches target Hermes source this fixture does not have.
        assert.deepStrictEqual(
          snapshot.patches.map((patch) => patch.state),
          HERMES_PATCHES.map(() => "doesNotApply"),
        );

        const unknown = yield* Effect.flip(
          service.apply({ patchId: HermesPatchId.make("not-shipped") }),
        );
        assert.strictEqual(unknown.reason, "unknownPatch");
        const misfit = yield* Effect.flip(service.apply({ patchId: HERMES_PATCHES[0]!.id }));
        assert.strictEqual(misfit.reason, "wrongState");
        assert.strictEqual(git(root, "status", "--porcelain"), "");
      }).pipe(withService({ enabled: true, binaryPath }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
