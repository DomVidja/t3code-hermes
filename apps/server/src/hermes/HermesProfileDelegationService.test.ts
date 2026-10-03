import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { makeHermesAdapter } from "../provider/Layers/HermesAdapter.ts";
import { ServerConfig } from "../config.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ServerSettings,
  HermesSettings,
  ApprovalRequestId,
  type ProviderRuntimeEvent,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Scope,
  Stream,
  Queue,
  Schema,
  Exit,
} from "effect";
import * as Authority from "./HermesParentSessionAuthority.ts";
import * as Delegation from "./HermesProfileDelegationService.ts";
import * as Settings from "../serverSettings.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const decodeReceipt = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      yolo: Schema.NullOr(Schema.String),
      mcpServers: Schema.Array(Schema.Unknown),
      metadata: Schema.Struct({ allowMcp: Schema.Boolean, allowNestedDelegation: Schema.Boolean }),
    }),
  ),
);

const target = ProviderInstanceId.make("researcher");
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("hermes"),
  providerSessionId: "parent",
  issuedAt: 1,
  capabilities: new Set(["profile-delegation"]),
};
const fixture = NodeURL.fileURLToPath(
  new URL("./fixtures/profile-delegation/agent.mjs", import.meta.url),
);

const makeFixture = Effect.fn(function* (noHandshake = false, grandchild = false) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-delegation-" });
  const binaryPath = `${directory}/hermes`;
  yield* fs.writeFileString(
    binaryPath,
    `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`,
  );
  yield* fs.chmod(binaryPath, 0o755);
  const settings = decodeSettings({
    providerInstances: {
      [target]: {
        driver: "hermes",
        enabled: true,
        config: { binaryPath },
        environment: [
          { name: "HERMES_HOME", value: directory },
          { name: "HERMES_YOLO_MODE", value: "1" },
          ...(grandchild ? [{ name: "T3_FIXTURE_GRANDCHILD", value: "1" }] : []),
          ...(noHandshake ? [{ name: "T3_FIXTURE_NO_HANDSHAKE", value: "1" }] : []),
        ],
      },
    },
  });
  const settingsService = Settings.ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(settings),
    updateSettings: () => Effect.succeed(settings),
    updateSettingsWith: () => Effect.succeed(settings),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  });
  const context = yield* Layer.build(
    Delegation.layer.pipe(
      Layer.provideMerge(Authority.layer),
      Layer.provide(Layer.succeed(Settings.ServerSettingsService, settingsService)),
      Layer.provide(NodeServices.layer),
    ),
  );
  const authority = yield* Authority.HermesParentSessionAuthority.pipe(Effect.provide(context));
  const delegation = yield* Delegation.HermesProfileDelegationService.pipe(Effect.provide(context));
  return { authority, delegation, directory };
});

for (const optionId of ["allowed", "denied"] as const) {
  it.live(
    `returns the actual child result after ${optionId} permission without a second parent turn`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { authority, delegation, directory } = yield* makeFixture();
          const requested = yield* Deferred.make<void>();
          const decision = yield* Deferred.make<void>();
          yield* authority.register({
            owner: invocation,
            runtimeMode: "approval-required",
            cwd: directory,
            allowedTargets: new Set([target]),
            requestPermission: (_id, childTarget, params) =>
              Effect.gen(function* () {
                assert.equal(childTarget, target);
                assert.equal(params.toolCall.toolCallId, "same-id");
                yield* Deferred.succeed(requested, undefined);
                yield* Deferred.await(decision);
                return { outcome: { outcome: "selected" as const, optionId } };
              }),
          });
          const child = yield* delegation
            .delegate(invocation, { targetInstanceId: target, task: "fixture" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(requested);
          yield* Deferred.succeed(decision, undefined);
          const result = yield* Fiber.join(child);
          assert.equal(result.output, optionId);
          const fs = yield* FileSystem.FileSystem;
          const receipt = decodeReceipt(yield* fs.readFileString(`${directory}/prompt.json`));
          assert.equal(receipt.yolo, null);
          assert.deepEqual(receipt.mcpServers, []);
          assert.equal(receipt.metadata.allowMcp, false);
          assert.equal(receipt.metadata.allowNestedDelegation, false);
          assert.equal(result.stopReason, "end_turn");
          assert.isFalse(result.truncated);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.live(
  "rejects wrong owners and closed parent leases, interrupting a child waiting on permission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { authority, delegation, directory } = yield* makeFixture();
        const parentScope = yield* Scope.make();
        const requested = yield* Deferred.make<void>();
        yield* authority
          .register({
            owner: invocation,
            runtimeMode: "approval-required",
            cwd: directory,
            allowedTargets: new Set([target]),
            requestPermission: () =>
              Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
          })
          .pipe(Effect.provideService(Scope.Scope, parentScope));
        const wrong = yield* authority
          .resolve({ ...invocation, threadId: ThreadId.make("other") }, target)
          .pipe(Effect.flip);
        assert.instanceOf(wrong, Authority.ProfileDelegationAuthorityError);
        for (const wrongScope of [
          { ...invocation, environmentId: EnvironmentId.make("other-environment") },
          { ...invocation, providerInstanceId: ProviderInstanceId.make("other-provider") },
          { ...invocation, providerSessionId: "stale-session" },
          { ...invocation, capabilities: new Set<"profile-delegation">() },
        ]) {
          const denied = yield* delegation
            .delegate(wrongScope, { targetInstanceId: target, task: "fixture" })
            .pipe(Effect.flip);
          assert.include(denied.message, "failed");
        }
        assert.deepEqual(yield* delegation.listTargets(invocation), [
          { targetInstanceId: target, displayName: target },
        ]);
        const child = yield* delegation
          .delegate(invocation, { targetInstanceId: target, task: "fixture" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(requested);
        yield* Scope.close(parentScope, Exit.void);
        const result = yield* Fiber.join(child).pipe(Effect.flip);
        assert.include(result.message, "parent session closed");
        const stale = yield* authority.resolve(invocation, target).pipe(Effect.flip);
        assert.instanceOf(stale, Authority.ProfileDelegationAuthorityError);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("fails closed before prompting a target that does not acknowledge supervision", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { authority, delegation, directory } = yield* makeFixture(true);
      const fs = yield* FileSystem.FileSystem;
      yield* authority.register({
        owner: invocation,
        runtimeMode: "full-access",
        cwd: directory,
        allowedTargets: new Set([target]),
        requestPermission: () => Effect.die("No child prompt may run without the handshake"),
      });
      const error = yield* delegation
        .delegate(invocation, { targetInstanceId: target, task: "fixture" })
        .pipe(Effect.flip);
      assert.include(error.message, "cannot enforce supervised");
      assert.isFalse(yield* fs.exists(`${directory}/prompt.json`));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "cancels current children while retaining the parent lease for a subsequent delegation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { authority, delegation, directory } = yield* makeFixture();
        const requested = yield* Deferred.make<void>();
        yield* authority.register({
          owner: invocation,
          runtimeMode: "approval-required",
          cwd: directory,
          allowedTargets: new Set([target]),
          requestPermission: () =>
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const child = yield* delegation
          .delegate(invocation, { targetInstanceId: target, task: "fixture" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(requested);
        yield* authority.cancelChildren(invocation.providerSessionId);
        const error = yield* Fiber.join(child).pipe(Effect.flip);
        assert.include(error.message, "cancelled delegation");
        const lease = yield* authority.resolve(invocation, target);
        assert.equal(lease.owner.providerSessionId, invocation.providerSessionId);
        assert.isFalse(yield* Deferred.isDone(lease.cancelled));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "routes simultaneous child approvals through the parent adapter and preserves its MCP credential",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { authority, delegation, directory } = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const rootBinary = `${directory}/parent-hermes`;
        const agent = NodeURL.fileURLToPath(
          new URL("../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        yield* fs.writeFileString(
          rootBinary,
          `#!/bin/sh\nexec '${process.execPath}' '${agent}' "$@"\n`,
        );
        yield* fs.chmod(rootBinary, 0o755);
        const mcpConfig = {
          ...invocation,
          endpoint: "http://fixture.invalid/mcp",
          authorizationHeader: "Bearer synthetic-parent-token",
          capabilities: invocation.capabilities,
        };
        McpProviderSession.setMcpProviderSession(mcpConfig);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(invocation.threadId)),
        );
        const configContext = yield* Layer.build(
          ServerConfig.layerTest(directory, { prefix: "t3-profile-parent-" }),
        );
        const adapter = yield* makeHermesAdapter(
          decodeHermesSettings({
            enabled: true,
            binaryPath: rootBinary,
            allowedProfileDelegationTargets: [target],
          }),
          {
            environment: { ...process.env, HERMES_HOME: directory },
            instanceId: invocation.providerInstanceId,
          },
        ).pipe(
          Effect.provide(configContext),
          Effect.provideService(Authority.HermesParentSessionAuthority, authority),
        );
        const requests =
          yield* Queue.unbounded<
            Extract<ProviderRuntimeEvent, { readonly type: "request.opened" }>
          >();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "request.opened"
              ? Queue.offer(requests, event).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* adapter.startSession({
          threadId: invocation.threadId,
          cwd: directory,
          runtimeMode: "full-access",
        });
        yield* Effect.addFinalizer(() =>
          adapter.stopSession(invocation.threadId).pipe(Effect.ignore),
        );
        const first = yield* delegation
          .delegate(invocation, { targetInstanceId: target, task: "first" })
          .pipe(Effect.forkScoped);
        const second = yield* delegation
          .delegate(invocation, { targetInstanceId: target, task: "second" })
          .pipe(Effect.forkScoped);
        const a = yield* Queue.take(requests);
        const b = yield* Queue.take(requests);
        assert.notEqual(a.requestId, b.requestId);
        assert.include(a.payload.detail ?? "", "Profile researcher child");
        assert.include(b.payload.detail ?? "", "Profile researcher child");
        yield* adapter.respondToRequest(
          invocation.threadId,
          ApprovalRequestId.make(String(a.requestId)),
          "accept",
        );
        yield* adapter.respondToRequest(
          invocation.threadId,
          ApprovalRequestId.make(String(b.requestId)),
          "decline",
        );
        const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        assert.deepEqual(results.map((result) => result.output).sort(), ["allowed", "denied"]);
        assert.equal(
          McpProviderSession.readMcpProviderSession(invocation.threadId)?.authorizationHeader,
          mcpConfig.authorizationHeader,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

for (const cancellation of ["parent-stop", "caller-disconnect"] as const) {
  it.live(`waits for ACP cancellation to terminate the owned command on ${cancellation}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { authority, delegation, directory } = yield* makeFixture(false, true);
        const fs = yield* FileSystem.FileSystem;
        yield* authority.register({
          owner: invocation,
          runtimeMode: "approval-required",
          cwd: directory,
          allowedTargets: new Set([target]),
          requestPermission: () =>
            Effect.succeed({ outcome: { outcome: "selected" as const, optionId: "allowed" } }),
        });
        const child = yield* delegation
          .delegate(invocation, { targetInstanceId: target, task: "fixture" })
          .pipe(Effect.forkScoped);
        yield* Effect.gen(function* () {
          while (!(yield* fs.exists(`${directory}/terminal.pid`))) yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("3 seconds"));
        const pid = Number(yield* fs.readFileString(`${directory}/terminal.pid`));
        // Clean up only this fixture-owned PID if the regression leaves it orphaned.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (processIsRunning(pid)) process.kill(pid, "SIGKILL");
          }),
        );
        assert.isTrue(processIsRunning(pid));
        if (cancellation === "parent-stop") {
          yield* authority.cancelChildren(invocation.providerSessionId);
          const error = yield* Fiber.join(child).pipe(Effect.flip);
          assert.include(error.message, "cancelled delegation");
        } else {
          yield* Fiber.interrupt(child);
        }
        assert.isFalse(processIsRunning(pid));
        assert.equal(yield* fs.readFileString(`${directory}/cancel-started`), "received");
        assert.equal(yield* fs.readFileString(`${directory}/cancel-cleaned`), "terminated");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}
