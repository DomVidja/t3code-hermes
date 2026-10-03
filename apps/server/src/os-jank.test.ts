import * as NodeOS from "node:os";
import { assert, it } from "vite-plus/test";

import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { hydratePosixHome, resolveBaseDir } from "./os-jank.ts";

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect("uses an isolated Lab backend home while preserving an explicit directory", () =>
  Effect.gen(function* () {
    const implicit = yield* resolveBaseDir(undefined);
    const explicit = yield* resolveBaseDir("/tmp/lab-custom");
    assert.equal(implicit, `${NodeOS.homedir()}/.t3-hermes-lab`);
    assert.equal(explicit, "/tmp/lab-custom");
  }).pipe(Effect.provide(NodePath.layer)),
);
