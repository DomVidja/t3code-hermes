import {
  HermesSettings,
  HermesProfileDelegationError,
  type HermesProfileDelegationInput,
  type HermesProfileDelegationResult,
  type HermesProfileDelegationTarget,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Crypto from "effect/Crypto";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import * as ParentAuthority from "./HermesParentSessionAuthority.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

export class HermesProfileDelegationService extends Context.Service<
  HermesProfileDelegationService,
  {
    readonly listTargets: (
      scope: McpInvocationScope,
      targetInstanceId?: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<HermesProfileDelegationTarget>, HermesProfileDelegationError>;
    readonly delegate: (
      scope: McpInvocationScope,
      input: HermesProfileDelegationInput,
    ) => Effect.Effect<HermesProfileDelegationResult, HermesProfileDelegationError>;
  }
>()("t3-hermes/hermes/HermesProfileDelegationService") {}

/** Child authentication belongs to its named profile and explicit target overrides. */
function childEnvironment(
  overrides: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  for (const entry of overrides ?? []) environment[entry.name] = entry.value;
  delete environment.HERMES_YOLO_MODE;
  delete environment.HERMES_INTERACTIVE;
  delete environment.HERMES_EXEC_ASK;
  delete environment.HERMES_GATEWAY_SESSION;
  delete environment.PYTHONPATH;
  delete environment.PYTHONHOME;
  return environment;
}

const SUPERVISED_TOOLS = [
  "terminal",
  "read_file",
  "write_file",
  "patch",
  "search_files",
  "web_search",
  "web_extract",
  "vision_analyze",
  "skills_list",
  "skill_view",
  "todo_list",
] as const;

const decodeHermesSettings = Schema.decodeUnknownEffect(HermesSettings);
const decodeSupervisionAck = Schema.decodeUnknownEffect(
  Schema.Struct({
    _meta: Schema.Struct({
      t3SupervisedProfileDelegationAccepted: Schema.Struct({
        version: Schema.Literal(1),
        accepted: Schema.Literal(true),
        delegationId: Schema.String,
        permissionMode: Schema.Literal("supervised"),
        effectiveToolNames: Schema.Array(Schema.Literals(SUPERVISED_TOOLS)),
        mcpEnabled: Schema.Literal(false),
        nestedDelegation: Schema.Literal(false),
      }),
    }),
  }),
);

const isDelegationError = Schema.is(HermesProfileDelegationError);

const make = Effect.gen(function* () {
  const authority = yield* ParentAuthority.HermesParentSessionAuthority;
  const settings = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const delegate = Effect.fn("HermesProfileDelegationService.delegate")(
    function* (scope: McpInvocationScope, input: HermesProfileDelegationInput) {
      const lease = yield* authority.resolve(scope, input.targetInstanceId);
      const current = yield* settings.getSettings;
      const target = current.providerInstances[input.targetInstanceId];
      if (!target || target.driver !== "hermes" || !resolveProviderInstanceEnabled(target)) {
        return yield* new HermesProfileDelegationError({
          detail: "The target must be an enabled, explicitly configured Hermes profile.",
        });
      }
      const config = yield* decodeHermesSettings(target.config ?? {});
      const environment = childEnvironment(target.environment);
      if (!environment.HERMES_HOME?.trim()) {
        return yield* new HermesProfileDelegationError({
          detail: "The delegation target must explicitly configure its Hermes profile home.",
        });
      }
      const childId = yield* crypto.randomUUIDv4;
      const run = Effect.scoped(
        Effect.gen(function* () {
          const runtimeContext = yield* Layer.build(
            AcpSessionRuntime.layer({
              spawn: {
                command: config.binaryPath,
                args: ["acp", "--supervised-profile-delegation"],
                cwd: lease.cwd,
                env: environment,
                extendEnv: false,
              },
              cwd: lease.cwd,
              clientInfo: { name: "t3-supervised-profile-delegation", version: "1" },
              authMethodId: "hermes",
              cancelBehavior: "wait-for-prompt",
              mcpServers: [],
              sessionMetadata: {
                t3SupervisedProfileDelegation: {
                  version: 1,
                  delegationId: childId,
                  parentRuntimeMode:
                    lease.runtimeMode === "full-access" ? "full-access" : "default",
                  permissionMode: "supervised",
                  allowedToolNames: [...SUPERVISED_TOOLS],
                  allowMcp: false,
                  allowNestedDelegation: false,
                },
              },
            }).pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
              Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
            ),
          );
          const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
            Effect.provide(runtimeContext),
          );
          yield* runtime.handleRequestPermission((params) =>
            lease.requestPermission(childId, input.targetInstanceId, params),
          );
          let output = "";
          let truncated = false;
          yield* runtime.getEvents().pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier")
                  yield* Deferred.succeed(event.acknowledge, undefined);
                if (event._tag === "ContentDelta") {
                  const room = Math.max(0, 100_000 - output.length);
                  output += event.text.slice(0, room);
                  truncated ||= event.text.length > room;
                }
              }),
            ),
            Effect.forkScoped,
          );
          const started = yield* runtime.start();
          const accepted = yield* decodeSupervisionAck(started.sessionSetupResult).pipe(
            Effect.option,
          );
          if (
            accepted._tag === "None" ||
            accepted.value._meta.t3SupervisedProfileDelegationAccepted.delegationId !== childId
          )
            return yield* new HermesProfileDelegationError({
              detail:
                "This Hermes build cannot enforce supervised profile delegation. Update the target before delegating.",
            });
          // Keep the prompt RPC alive while cancellation runs. Interrupting prompt
          // directly clears its active state before cancel can await Hermes cleanup.
          const prompt = yield* runtime
            .prompt({ prompt: [{ type: "text", text: input.task }] })
            .pipe(Effect.forkScoped);
          const result = yield* Fiber.join(prompt).pipe(
            Effect.onInterrupt(() => runtime.cancel.pipe(Effect.ignore)),
          );
          yield* runtime.drainEvents;
          return {
            childId,
            targetInstanceId: input.targetInstanceId,
            stopReason: result.stopReason,
            output,
            truncated,
          };
        }),
      );
      return yield* Effect.raceFirst(
        run,
        Effect.raceFirst(Deferred.await(lease.closed), Deferred.await(lease.cancelled)).pipe(
          Effect.andThen(
            Effect.fail(
              new HermesProfileDelegationError({
                detail: "The parent session closed or cancelled delegation.",
              }),
            ),
          ),
        ),
      ).pipe(Effect.timeout("10 minutes"));
    },
    Effect.mapError((cause) =>
      isDelegationError(cause)
        ? cause
        : new HermesProfileDelegationError({
            detail: "Profile delegation failed or timed out. The child process was stopped.",
          }),
    ),
  );
  const listTargets = Effect.fn("HermesProfileDelegationService.listTargets")(
    function* (scope: McpInvocationScope, filterTarget?: ProviderInstanceId) {
      const lease = yield* authority.resolve(scope);
      const current = yield* settings.getSettings;
      return [...lease.allowedTargets]
        .filter((id) => filterTarget === undefined || id === filterTarget)
        .flatMap((targetInstanceId) => {
          const target = current.providerInstances[targetInstanceId];
          return target &&
            target.driver === "hermes" &&
            resolveProviderInstanceEnabled(target) &&
            target.environment?.some(
              (entry) => entry.name === "HERMES_HOME" && entry.value.trim().length > 0,
            )
            ? [{ targetInstanceId, displayName: target.displayName ?? targetInstanceId }]
            : [];
        });
    },
    Effect.mapError(
      () =>
        new HermesProfileDelegationError({
          detail: "This session cannot list delegation targets.",
        }),
    ),
  );
  return HermesProfileDelegationService.of({ delegate, listTargets });
});
export const layer = Layer.effect(HermesProfileDelegationService, make);
