// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type HermesSkillsStreamEvent,
  type ServerSettings as Settings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerSettings from "../serverSettings.ts";
import { HermesSkillsService, layer } from "./HermesSkillsService.ts";

const body = (name: string) =>
  `---\nname: ${name}\ndescription: A learned procedure\n---\n# ${name}\n`;

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-service-" });
  yield* fs.makeDirectory(`${root}/skills/example`, { recursive: true });
  yield* fs.writeFileString(`${root}/skills/example/SKILL.md`, body("original"));
  const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
  const started = yield* Deferred.make<void>();
  const consumed = yield* Deferred.make<void>();
  const watcherCount = yield* Ref.make(0);
  const watchedPaths = yield* Ref.make<readonly string[]>([]);
  const watchedFs = FileSystem.FileSystem.of({
    ...fs,
    watch: (path) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Ref.update(watcherCount, (n) => n + 1);
          yield* Ref.update(watchedPaths, (paths) => [...paths, path]);
          yield* Effect.addFinalizer(() => Ref.update(watcherCount, (n) => n - 1));
          yield* Deferred.succeed(started, undefined);
          return Stream.fromQueue(events).pipe(
            Stream.tap(() => Deferred.succeed(consumed, undefined)),
          );
        }),
      ),
  });
  const settingsLayer = ServerSettings.layerTest({
    providerInstances: {
      [ProviderInstanceId.make("hermes")]: {
        driver: ProviderDriverKind.make("hermes"),
        enabled: true,
        environment: [{ name: "HERMES_HOME", value: root, sensitive: false }],
      },
    },
  });
  return {
    root,
    fs,
    watchedFs,
    events,
    started,
    consumed,
    watcherCount,
    watchedPaths,
    settingsLayer,
    serviceLayer: layer.pipe(
      Layer.provide(settingsLayer),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, watchedFs)),
    ),
  };
});

describe("HermesSkillsService", () => {
  it.effect(
    "reads instance env and refreshes before the first snapshot, including after reopening",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* Effect.gen(function* () {
          const service = yield* HermesSkillsService;
          expect((yield* service.list({})).skills[0]?.name).toBe("original");
          yield* h.fs.writeFileString(`${h.root}/skills/example/SKILL.md`, body("reopened"));
          const snapshot = yield* service.subscribe.pipe(Effect.flatMap(Stream.runHead));
          expect(snapshot).toMatchObject({
            value: { snapshot: { skills: [{ name: "reopened" }] } },
          });
          expect((yield* service.get({ path: "example" })).markdown).toContain("# reopened");
          const failure = yield* service.get({ path: "../outside" }).pipe(Effect.flip);
          expect(failure.reason).toBe("unknownSkill");
        }).pipe(Effect.provide(h.serviceLayer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "pushes watched edits, deduplicates identical refreshes, and releases the shared watcher",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* Effect.gen(function* () {
          const service = yield* HermesSkillsService;
          const scope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const stream = yield* service.subscribe.pipe(Scope.provide(scope));
          yield* service.subscribe.pipe(Scope.provide(secondScope), Effect.asVoid);
          const seen = yield* Queue.unbounded<HermesSkillsStreamEvent>();
          const collector = yield* Stream.runForEach(stream, (event) =>
            Queue.offer(seen, event),
          ).pipe(Effect.forkScoped);
          expect((yield* Queue.take(seen)).snapshot.skills[0]?.name).toBe("original");
          yield* Deferred.await(h.started);
          expect(yield* Ref.get(h.watcherCount)).toBe(1);
          expect(yield* Ref.get(h.watchedPaths)).toEqual([NodePath.join(h.root, "skills")]);
          yield* service.list({ refresh: true });
          expect(yield* Queue.size(seen)).toBe(0);

          yield* h.fs.writeFileString(`${h.root}/skills/example/SKILL.md`, body("learned"));
          yield* h.fs.writeFileString(
            `${h.root}/skills/.curator_ledger.jsonl`,
            `{"id":"learned","ts":"2026-09-29T12:00:00Z","actor":"agent","action":"create","skill":"learned","before":[],"after":[]}\n`,
          );
          yield* Queue.offer(h.events, { _tag: "Update", path: ".curator_ledger.jsonl" });
          yield* Deferred.await(h.consumed);
          yield* TestClock.adjust("200 millis");
          expect((yield* Queue.take(seen)).snapshot.skills[0]).toMatchObject({
            name: "learned",
            origin: "agent-created",
            lastModifiedByHermes: "2026-09-29T12:00:00.000Z",
          });
          yield* Scope.close(secondScope, Exit.void);
          expect(yield* Ref.get(h.watcherCount)).toBe(1);
          yield* Scope.close(scope, Exit.void);
          expect(yield* Ref.get(h.watcherCount)).toBe(0);
          yield* Fiber.interrupt(collector);
        }).pipe(Effect.provide(h.serviceLayer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports disabled without touching the filesystem and rejects detail requests", () =>
    Effect.gen(function* () {
      const service = yield* HermesSkillsService;
      expect((yield* service.list({ refresh: true })).availability).toBe("providerDisabled");
      expect((yield* service.get({ path: "anything" }).pipe(Effect.flip)).reason).toBe(
        "providerDisabled",
      );
      const snapshot = yield* service.subscribe.pipe(Effect.flatMap(Stream.runHead));
      expect(snapshot).toMatchObject({ value: { snapshot: { availability: "providerDisabled" } } });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            Layer.succeed(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                watch: () => {
                  throw new Error("Disabled Hermes must not watch files");
                },
              }),
            ),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("rebinds subscriptions when the enabled instance changes home", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const changes = yield* PubSub.unbounded<Settings>();
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const current = yield* Ref.make(yield* settings.getSettings);
        const dynamicSettings = ServerSettings.ServerSettingsService.of({
          ...settings,
          getSettings: Ref.get(current),
          subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
        });
        yield* Effect.gen(function* () {
          const service = yield* HermesSkillsService;
          const seen = yield* Queue.unbounded<HermesSkillsStreamEvent>();
          const stream = yield* service.subscribe;
          yield* Stream.runForEach(stream, (event) => Queue.offer(seen, event)).pipe(
            Effect.forkScoped,
          );
          expect((yield* Queue.take(seen)).snapshot.availability).toBe("ready");
          yield* Deferred.await(h.started);
          const disabled = { ...(yield* Ref.get(current)), providerInstances: {} };
          yield* Ref.set(current, disabled);
          yield* PubSub.publish(changes, disabled);
          expect((yield* Queue.take(seen)).snapshot.availability).toBe("providerDisabled");
          expect(yield* Ref.get(h.watcherCount)).toBe(0);
          yield* h.fs.makeDirectory(`${h.root}/other/skills/different`, { recursive: true });
          yield* h.fs.writeFileString(
            `${h.root}/other/skills/different/SKILL.md`,
            body("new home"),
          );
          const enabled = {
            ...disabled,
            providerInstances: {
              [ProviderInstanceId.make("hermes")]: {
                driver: ProviderDriverKind.make("hermes"),
                enabled: true,
                environment: [{ name: "HERMES_HOME", value: `${h.root}/other`, sensitive: false }],
              },
            },
          };
          yield* Ref.set(current, enabled);
          yield* PubSub.publish(changes, enabled);
          const firstHome = (yield* Queue.take(seen)).snapshot;
          expect(firstHome.skills[0]?.name).toBe("new home");
          yield* h.fs.makeDirectory(`${h.root}/third/skills/different`, { recursive: true });
          yield* h.fs.writeFileString(
            `${h.root}/third/skills/different/SKILL.md`,
            body("new home") + "Different body, identical metadata.",
          );
          const sameMetadata = {
            ...enabled,
            providerInstances: {
              [ProviderInstanceId.make("hermes")]: {
                driver: ProviderDriverKind.make("hermes"),
                enabled: true,
                environment: [{ name: "HERMES_HOME", value: `${h.root}/third`, sensitive: false }],
              },
            },
          };
          yield* Ref.set(current, sameMetadata);
          yield* PubSub.publish(changes, sameMetadata);
          const nextHome = (yield* Queue.take(seen)).snapshot;
          expect(nextHome.skills).toEqual(firstHome.skills);
          expect(nextHome.revision).toBeGreaterThan(firstHome.revision);
          expect((yield* service.get({ path: "different" })).markdown).toContain("Different body");
        }).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, dynamicSettings)),
              Layer.provide(Layer.succeed(FileSystem.FileSystem, h.watchedFs)),
            ),
          ),
        );
      }).pipe(Effect.provide(h.settingsLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
