// @effect-diagnostics nodeBuiltinImport:off - builds fixture git repos synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HermesPatchId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { HERMES_PATCH_FILES } from "./hermesPatchFiles.generated.ts";
import {
  changeHermesPatch,
  HERMES_PATCHES,
  isHermesCheckoutDetached,
  readHermesPatches,
  resolveHermesGitCheckout,
  type HermesPatchDefinition,
} from "./hermesPatches.ts";

const INFRA_HERMES = NodePath.resolve(import.meta.dirname, "../../../../infra/hermes");

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

/** A one-file repo on `main`, plus a patch that rewrites that file. */
const makeCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
  git(root, "init", "--quiet");
  NodeFS.writeFileSync(NodePath.join(root, "session.py"), "remote_cwd = None\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "base");
  NodeFS.writeFileSync(NodePath.join(root, "session.py"), "remote_cwd = configured()\n");
  const content = git(root, "diff");
  git(root, "checkout", "--quiet", "--", ".");
  const patch: HermesPatchDefinition = {
    id: HermesPatchId.make("test-patch"),
    title: "Test",
    neededFor: "Tests.",
    content,
  };
  return { root, patch };
});

describe("hermes patches", () => {
  it("embeds every infra/hermes patch, byte for byte", () => {
    const onDisk = Object.fromEntries(
      NodeFS.readdirSync(INFRA_HERMES)
        .filter((name) => name.endsWith(".patch"))
        .map((name) => [name, NodeFS.readFileSync(NodePath.join(INFRA_HERMES, name), "utf8")]),
    );
    // Regenerate with `node scripts/generate-hermes-patches.ts`.
    assert.deepStrictEqual(HERMES_PATCH_FILES, onDisk);
    const shipped = new Set(HERMES_PATCHES.map((patch) => patch.content));
    for (const [name, content] of Object.entries(onDisk)) {
      assert.isTrue(shipped.has(content), `${name} has no entry in HERMES_PATCHES`);
    }
  });

  it.effect("reads, applies, and removes a patch", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;
      const state = () => readHermesPatches(root, [patch]).pipe(Effect.map(([s]) => s?.state));

      assert.strictEqual(yield* state(), "notApplied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(yield* state(), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(yield* state(), "notApplied");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a patch the checkout has drifted away from as not applying", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;
      NodeFS.writeFileSync(NodePath.join(root, "session.py"), "remote_cwd = rewritten()\n");

      const [status] = yield* readHermesPatches(root, [patch]);
      assert.strictEqual(status?.state, "doesNotApply");
      const refused = yield* changeHermesPatch(root, patch, "forward");
      assert.isFalse(refused.ok);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(root, "session.py"), "utf8"),
        "remote_cwd = rewritten()\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("notices a detached HEAD, which hermes update cannot move", () =>
    Effect.gen(function* () {
      const { root } = yield* makeCheckout;
      assert.isFalse(yield* isHermesCheckoutDetached(root));
      git(root, "checkout", "--quiet", "--detach");
      assert.isTrue(yield* isHermesCheckoutDetached(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds the checkout only for a venv binary beside a .git", () =>
    Effect.gen(function* () {
      const { root } = yield* makeCheckout;
      const binary = NodePath.join(root, "venv", "bin", "hermes");
      assert.strictEqual(yield* resolveHermesGitCheckout(binary), root);
      assert.isNull(yield* resolveHermesGitCheckout("/usr/bin/hermes"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
