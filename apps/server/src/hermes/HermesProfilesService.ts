import {
  HermesProfile,
  HermesProfileList,
  HermesProfilesError,
  type HermesInstanceScope,
  type HermesProfileConfigureInput,
  type HermesProfileCreateInput,
  type HermesProfileShowInput,
  type HermesProfileLinkInput,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { Context, Effect, Layer, Path, Schema, Semaphore } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as ServerSettings from "../serverSettings.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { collectStreamAsString } from "../provider/providerSnapshot.ts";
import { resolveEnabledHermesInstance } from "./hermesCronState.ts";

const profileResponse = Schema.Struct({
  schema_version: Schema.Literal(1),
  profile: HermesProfile,
});
const listResponse = Schema.Struct({
  schema_version: Schema.Literal(1),
  ...HermesProfileList.fields,
});
const errorResponse = Schema.Struct({
  schema_version: Schema.Literal(1),
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProfile = Schema.decodeUnknownEffect(profileResponse);
const decodeList = Schema.decodeUnknownEffect(listResponse);
const decodeError = Schema.decodeUnknownOption(errorResponse);
const isProfilesError = Schema.is(HermesProfilesError);

export class HermesProfilesService extends Context.Service<
  HermesProfilesService,
  {
    readonly list: (
      input: HermesInstanceScope,
    ) => Effect.Effect<typeof HermesProfileList.Type, HermesProfilesError>;
    readonly show: (
      input: typeof HermesProfileShowInput.Type,
    ) => Effect.Effect<HermesProfile, HermesProfilesError>;
    readonly create: (
      input: typeof HermesProfileCreateInput.Type,
    ) => Effect.Effect<HermesProfile, HermesProfilesError>;
    readonly configure: (
      input: HermesProfileConfigureInput,
    ) => Effect.Effect<HermesProfile, HermesProfilesError>;
    readonly link: (
      input: typeof HermesProfileLinkInput.Type,
    ) => Effect.Effect<{ readonly instanceId: ProviderInstanceId }, HermesProfilesError>;
  }
>()("t3-hermes/hermes/HermesProfilesService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const writes = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const instance = (input: HermesInstanceScope) =>
    Effect.gen(function* () {
      const value = yield* settings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new HermesProfilesError({
              code: "settings_unreadable",
              detail: "Environment settings could not be read.",
              cause,
            }),
        ),
      );
      const selected = resolveEnabledHermesInstance(value, input.instanceId);
      if (selected === null)
        return yield* new HermesProfilesError({
          code: "provider_disabled",
          detail: "The selected Hermes instance is unavailable or disabled.",
        });
      return selected;
    });
  const execute = (input: HermesInstanceScope, args: readonly string[]) =>
    Effect.gen(function* () {
      const selected = yield* instance(input);
      const env = mergeProviderInstanceEnvironment(selected.environment);
      const resolved = yield* resolveSpawnCommand(
        selected.settings.binaryPath || "hermes",
        [...args],
        { env },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new HermesProfilesError({
              code: "command_failed",
              detail: "The Hermes CLI could not be started.",
              cause,
            }),
        ),
      );
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(resolved.command, resolved.args, { env, shell: resolved.shell }),
          );
          const [stdout, , exitCode] = yield* Effect.all(
            [
              collectStreamAsString(child.stdout, { maxBytes: 262144 }),
              collectStreamAsString(child.stderr, { maxBytes: 16384 }),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { stdout, exitCode: Number(exitCode) };
        }),
      ).pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.mapError(
          (cause) =>
            new HermesProfilesError({
              code: "command_failed",
              detail: "The Hermes profile command failed.",
              cause,
            }),
        ),
      );
      if (result._tag === "None")
        return yield* new HermesProfilesError({
          code: "timeout",
          detail: "The Hermes profile command timed out.",
        });
      const parsed = yield* decodeJson(result.value.stdout).pipe(
        Effect.mapError(
          () =>
            new HermesProfilesError({
              code: "unsupported",
              detail:
                "This Hermes CLI does not support the profile JSON interface. Use the patched Hermes build.",
            }),
        ),
      );
      const failure = decodeError(parsed);
      if (failure._tag === "Some")
        return yield* new HermesProfilesError({
          code: failure.value.error.code,
          detail: failure.value.error.message,
        });
      if (result.value.exitCode !== 0)
        return yield* new HermesProfilesError({
          code: "command_failed",
          detail: `Hermes profile command exited with code ${result.value.exitCode}.`,
        });
      return parsed;
    });
  const readProfile = (input: HermesInstanceScope, args: readonly string[]) =>
    execute(input, args).pipe(
      Effect.flatMap(decodeProfile),
      Effect.flatMap((value) =>
        value.profile.name === args[2] && path.isAbsolute(value.profile.path)
          ? Effect.succeed(value.profile)
          : Effect.fail(
              new HermesProfilesError({
                code: "unsupported",
                detail: "The Hermes CLI returned a mismatched profile name or non-canonical home.",
              }),
            ),
      ),
      Effect.mapError((cause) =>
        isProfilesError(cause)
          ? cause
          : new HermesProfilesError({
              code: "unsupported",
              detail: "The Hermes profile response has an unsupported format.",
              cause,
            }),
      ),
    );
  const show = (input: typeof HermesProfileShowInput.Type) =>
    readProfile(input, ["profile", "show", input.name, "--json"]);
  return HermesProfilesService.of({
    list: (input) =>
      execute(input, ["profile", "list", "--json"]).pipe(
        Effect.flatMap(decodeList),
        Effect.map((value) => ({ profiles: value.profiles })),
        Effect.mapError((cause) =>
          isProfilesError(cause)
            ? cause
            : new HermesProfilesError({
                code: "unsupported",
                detail: "The Hermes profile list has an unsupported format.",
                cause,
              }),
        ),
      ),
    show,
    create: (input) =>
      writes.withPermits(1)(
        readProfile(input, [
          "profile",
          "create",
          input.name,
          "--json",
          ...(input.description === undefined ? [] : ["--description", input.description]),
          ...(input.noSkills ? ["--no-skills"] : []),
        ]),
      ),
    configure: (input) =>
      writes.withPermits(1)(
        readProfile(input, [
          "profile",
          "configure",
          input.name,
          "--json",
          "--platform",
          "acp",
          ...(
            [
              ["--model", input.model],
              ["--provider", input.provider],
              ["--reasoning-effort", input.reasoningEffort],
              ["--toolsets", input.toolsets],
            ] as const
          ).flatMap(([key, value]) => (value === undefined ? [] : [key, value])),
          ...(input.confirmExpensiveModel ? ["--confirm-expensive-model"] : []),
        ]),
      ),
    link: (input) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const profile = yield* show(input);
          const selected = yield* instance(input);
          yield* settings.updateSettingsWith((current) =>
            Effect.gen(function* () {
              if (current.providerInstances[input.newInstanceId] !== undefined)
                return yield* new HermesProfilesError({
                  code: "instance_exists",
                  detail: "That provider instance already exists. Choose a new instance id.",
                });
              const latest = resolveEnabledHermesInstance(current, selected.instanceId);
              if (latest === null || latest.settings.binaryPath !== selected.settings.binaryPath)
                return yield* new HermesProfilesError({
                  code: "provider_changed",
                  detail:
                    "The source Hermes instance changed or was disabled while linking. Refresh and try again.",
                });
              return {
                providerInstances: {
                  ...current.providerInstances,
                  [input.newInstanceId]: {
                    driver: ProviderDriverKind.make("hermes"),
                    displayName: input.displayName || profile.display_name || profile.name,
                    enabled: true,
                    config: {
                      enabled: true,
                      binaryPath: latest.settings.binaryPath,
                      customModels: latest.settings.customModels,
                    },
                    environment: [{ name: "HERMES_HOME", value: profile.path, sensitive: false }],
                  },
                },
              };
            }),
          );
          return { instanceId: input.newInstanceId };
        }).pipe(
          Effect.mapError((cause) =>
            isProfilesError(cause)
              ? cause
              : new HermesProfilesError({
                  code: "settings_failed",
                  detail: "The profile could not be linked to T3.",
                  cause,
                }),
          ),
        ),
      ),
  });
});
export const layer = Layer.effect(HermesProfilesService, make);
export const layerTest = Layer.succeed(
  HermesProfilesService,
  HermesProfilesService.of({
    list: () => Effect.succeed({ profiles: [] }),
    show: () =>
      Effect.fail(
        new HermesProfilesError({ code: "unavailable", detail: "Profiles unavailable." }),
      ),
    create: () =>
      Effect.fail(
        new HermesProfilesError({ code: "unavailable", detail: "Profiles unavailable." }),
      ),
    configure: () =>
      Effect.fail(
        new HermesProfilesError({ code: "unavailable", detail: "Profiles unavailable." }),
      ),
    link: () =>
      Effect.fail(
        new HermesProfilesError({ code: "unavailable", detail: "Profiles unavailable." }),
      ),
  }),
);
