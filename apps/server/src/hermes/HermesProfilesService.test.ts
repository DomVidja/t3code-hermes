// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as ServerSettings from "../serverSettings.ts";
import * as Profiles from "./HermesProfilesService.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const id = ProviderInstanceId.make("hermes-test");
const fixture = (
  beforeLink?: (
    settings: ServerSettings.ServerSettingsService["Service"],
  ) => Effect.Effect<void, ServerSettingsError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "hermes-profile-service-" });
    const binary = path.join(root, "hermes-fixture");
    const profile = {
      name: "research",
      path: path.join(root, "research"),
      is_default: false,
      display_name: "Research",
      description: "Fresh",
      model: { default: "fixture-model", provider: "fixture" },
      reasoning_effort: "high",
      platform_toolsets: { acp: ["hermes-acp"] },
    };
    yield* fs.writeFileString(path.join(root, "profile.json"), yield* encodeJson(profile));
    yield* fs.writeFileString(
      binary,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(args)+'\\n');
if (args.includes('unsupported')) { console.log('old human-only CLI'); process.exit(2); }
if (args.includes('guarded') && !args.includes('--confirm-expensive-model')) { console.log(JSON.stringify({schema_version:1,error:{code:'confirmation_required',message:'Approve the fixture model cost warning'}})); process.exit(2); }
const profile = JSON.parse(fs.readFileSync(process.env.PROFILE_DATA,'utf8'));
console.log(JSON.stringify(args[1]==='list' ? {schema_version:1,profiles:[{...profile,model:profile.model.default,provider:profile.model.provider,skill_count:0}]} : {schema_version:1,profile}));
`,
    );
    yield* fs.chmod(binary, 0o755);
    const settingsLayer = ServerSettings.layerTest({
      providerInstances: {
        [id]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: true,
          config: { binaryPath: binary },
          environment: [
            { name: "HERMES_HOME", value: root, sensitive: false },
            { name: "ARGV_LOG", value: path.join(root, "argv.jsonl"), sensitive: false },
            { name: "PROFILE_DATA", value: path.join(root, "profile.json"), sensitive: false },
            { name: "FIXTURE_SECRET", value: "not-a-real-secret", sensitive: true },
          ],
        },
      },
    });
    return {
      fs,
      path,
      root,
      profile,
      binary,
      layer: Profiles.layer.pipe(
        Layer.provideMerge(
          beforeLink === undefined
            ? settingsLayer
            : Layer.effect(
                ServerSettings.ServerSettingsService,
                Effect.gen(function* () {
                  const source = yield* ServerSettings.ServerSettingsService;
                  return {
                    ...source,
                    updateSettings: (patch) =>
                      beforeLink(source).pipe(Effect.andThen(source.updateSettings(patch))),
                    updateSettingsWith: (makePatch) =>
                      beforeLink(source).pipe(Effect.andThen(source.updateSettingsWith(makePatch))),
                  } satisfies ServerSettings.ServerSettingsService["Service"];
                }),
              ).pipe(Layer.provide(settingsLayer)),
        ),
      ),
    };
  });

describe("HermesProfilesService", () => {
  it.live("preserves a concurrent provider add and credential revocation while linking", () =>
    Effect.gen(function* () {
      const concurrentId = ProviderInstanceId.make("concurrent-provider");
      const h = yield* fixture((source) =>
        Effect.gen(function* () {
          const current = yield* source.getSettings;
          yield* source.updateSettings({
            providerInstances: {
              ...current.providerInstances,
              [id]: {
                ...current.providerInstances[id]!,
                environment: current.providerInstances[id]!.environment!.filter(
                  (entry) => entry.name !== "FIXTURE_SECRET",
                ),
              },
              [concurrentId]: { driver: ProviderDriverKind.make("hermes"), enabled: false },
            },
          });
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* Profiles.HermesProfilesService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const linked = ProviderInstanceId.make("linked-research");
        yield* service.link({
          instanceId: id,
          name: "research",
          newInstanceId: linked,
          displayName: "Research",
        });
        const saved = yield* settings.getSettings;
        expect(saved.providerInstances[linked]).toBeDefined();
        expect(saved.providerInstances[concurrentId]).toBeDefined();
        expect(
          saved.providerInstances[id]!.environment?.some(
            (entry) => entry.name === "FIXTURE_SECRET",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("rejects linking if the selected source is disabled during the settings race", () =>
    Effect.gen(function* () {
      const h = yield* fixture((source) =>
        Effect.gen(function* () {
          const current = yield* source.getSettings;
          yield* source.updateSettings({
            providerInstances: {
              ...current.providerInstances,
              [id]: { ...current.providerInstances[id]!, enabled: false },
            },
          });
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* Profiles.HermesProfilesService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const linked = ProviderInstanceId.make("linked-research");
        expect(
          (yield* Effect.flip(
            service.link({
              instanceId: id,
              name: "research",
              newInstanceId: linked,
              displayName: "Research",
            }),
          )).code,
        ).toBe("provider_changed");
        expect((yield* settings.getSettings).providerInstances[linked]).toBeUndefined();
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live(
    "passes bounded argument arrays and returns guarded-model errors until explicitly confirmed",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture();
        yield* Effect.gen(function* () {
          const service = yield* Profiles.HermesProfilesService;
          const error = yield* Effect.flip(
            service.configure({
              instanceId: id,
              name: "research",
              model: "guarded",
              provider: "fixture",
            }),
          );
          expect(error.code).toBe("confirmation_required");
          yield* service.configure({
            instanceId: id,
            name: "research",
            model: "guarded",
            provider: "fixture",
            confirmExpensiveModel: true,
            toolsets: "hermes-acp,cronjob",
          });
          const args = (yield* h.fs.readFileString(h.path.join(h.root, "argv.jsonl")))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(args[0]).toEqual([
            "profile",
            "configure",
            "research",
            "--json",
            "--platform",
            "acp",
            "--model",
            "guarded",
            "--provider",
            "fixture",
          ]);
          expect(args[1]).toContain("--confirm-expensive-model");
          expect(args[1]).toContain("hermes-acp,cronjob");
          expect(
            (yield* Effect.flip(service.show({ instanceId: id, name: "unsupported" }))).code,
          ).toBe("unsupported");
        }).pipe(Effect.provide(h.layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live(
    "re-reads metadata and links only the CLI-resolved home without copying environment secrets or overwriting instances",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture();
        yield* Effect.gen(function* () {
          const service = yield* Profiles.HermesProfilesService;
          const settings = yield* ServerSettings.ServerSettingsService;
          expect((yield* service.show({ instanceId: id, name: "research" })).model.default).toBe(
            "fixture-model",
          );
          yield* h.fs.writeFileString(
            h.path.join(h.root, "profile.json"),
            yield* encodeJson({
              ...h.profile,
              model: { default: "edited", provider: "fixture" },
            }),
          );
          expect((yield* service.show({ instanceId: id, name: "research" })).model.default).toBe(
            "edited",
          );
          const next = ProviderInstanceId.make("hermes-research");
          yield* service.link({
            instanceId: id,
            name: "research",
            newInstanceId: next,
            displayName: "Research",
          });
          const saved = (yield* settings.getSettings).providerInstances[next];
          expect(saved?.environment).toEqual([
            { name: "HERMES_HOME", value: h.profile.path, sensitive: false },
          ]);
          expect(saved?.config).toMatchObject({ binaryPath: h.binary });
          expect(saved?.enabled).toBe(true);
          expect(
            (yield* Effect.flip(
              service.link({
                instanceId: id,
                name: "research",
                newInstanceId: next,
                displayName: "Other",
              }),
            )).code,
          ).toBe("instance_exists");
          expect(
            (yield* Effect.flip(service.list({ instanceId: ProviderInstanceId.make("missing") })))
              .code,
          ).toBe("provider_disabled");
        }).pipe(Effect.provide(h.layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
