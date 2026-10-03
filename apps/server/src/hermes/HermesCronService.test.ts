import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HERMES_CRON_OUTPUT_LENGTH,
  HERMES_CRON_PREVIEW_LENGTH,
  HermesCronJobId,
  HermesCronSnapshot,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HermesCron from "./HermesCronService.ts";
import {
  appendHermesDeliveryFixture,
  createHermesDeliveryFixture,
  FIXTURE_JOB_ID,
} from "./hermesCronDeliveryFixtures.ts";

const instanceId = ProviderInstanceId.make("hermes");
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(HermesCronSnapshot));
const jobId = HermesCronJobId.make(FIXTURE_JOB_ID);
const HISTORY_AT = "2026-08-01T08:00:00.000Z";
const NEW_RUN_AT = "2026-08-01T09:00:00.000Z";
const LATER_RUN_AT = "2026-08-01T10:00:00.000Z";

const providerEnvironment = (home: string) => [
  { name: "HERMES_HOME", value: home, sensitive: false },
];

const makeFixture = Effect.fn(function* (
  enabled = true,
  options: { id?: ProviderInstanceId; legacyMuted?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-cron-service-" });
  const home = path.join(directory, "hermes");
  yield* Effect.sync(() => createHermesDeliveryFixture(home));
  if (options.legacyMuted) {
    const stateDir = path.join(directory, "server", "userdata");
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(stateDir, "hermes-cron-mutes.json"),
      `{"version":1,"mutedJobIds":["${jobId}"]}`,
    );
  }
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest(directory, path.join(directory, "server")),
    ServerSettings.layerTest({
      providerInstances: {
        [options.id ?? instanceId]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled,
          environment: providerEnvironment(home),
        },
      },
    }),
  );
  const context = yield* Layer.build(HermesCron.layer.pipe(Layer.provideMerge(dependencies)));
  return {
    service: Context.get(context, HermesCron.HermesCronService),
    settings: Context.get(context, ServerSettings.ServerSettingsService),
    directory,
    home,
    fs,
    path,
  };
});

it.layer(NodeServices.layer)("HermesCronService", (it) => {
  it.effect(
    "shares legacy mutes between default and explicit aliases and keeps identities stable when the default changes",
    () =>
      Effect.gen(function* () {
        const bid = ProviderInstanceId.make("hermes-b");
        const { service, settings, directory, path, home } = yield* makeFixture(true, {
          id: bid,
          legacyMuted: true,
        });
        expect((yield* service.list({ refresh: true })).jobs[0]?.muted).toBe(true);
        expect((yield* service.list({ instanceId: bid })).jobs[0]?.muted).toBe(true);
        const events = yield* Stream.toQueue(yield* service.subscribe({}), {
          capacity: "unbounded",
        });
        expect(yield* Queue.take(events)).toMatchObject({ _tag: "snapshot" });
        const unmuted = yield* service.setMuted({ instanceId: bid, jobId, muted: false });
        expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: unmuted });
        expect((yield* service.list({ refresh: true })).jobs[0]?.muted).toBe(false);
        yield* service.setMuted({ jobId, muted: true });
        expect((yield* service.list({ instanceId: bid })).jobs[0]?.muted).toBe(true);
        const aHome = path.join(directory, "hermes-a");
        yield* Effect.sync(() => {
          createHermesDeliveryFixture(aHome);
          appendHermesDeliveryFixture(home, { id: "b-history", startedAt: HISTORY_AT });
          appendHermesDeliveryFixture(aHome, { id: "a-history", startedAt: HISTORY_AT });
        });
        yield* settings.updateSettings({
          providerInstances: {
            ...(yield* settings.getSettings).providerInstances,
            [instanceId]: {
              driver: ProviderDriverKind.make("hermes"),
              enabled: true,
              environment: providerEnvironment(aHome),
            },
          },
        });
        const newDefault = yield* service.list({ refresh: true });
        expect(newDefault.jobs[0]).toMatchObject({ muted: false, runs: [{ id: "a-history" }] });
        expect((yield* service.list({ instanceId: bid, refresh: true })).jobs[0]).toMatchObject({
          muted: true,
          runs: [{ id: "b-history" }],
        });
        expect((yield* service.list({ instanceId, refresh: true })).jobs[0]?.muted).toBe(false);
        const restarted = yield* Layer.build(
          Layer.fresh(HermesCron.layer).pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerConfig.layerTest(directory, path.join(directory, "server")),
                Layer.succeed(ServerSettings.ServerSettingsService, settings),
              ),
            ),
          ),
        );
        const restartedService = Context.get(restarted, HermesCron.HermesCronService);
        expect((yield* restartedService.list({ refresh: true })).jobs[0]?.muted).toBe(false);
        expect(
          (yield* restartedService.list({ instanceId: bid, refresh: true })).jobs[0]?.muted,
        ).toBe(true);
      }),
  );

  it.effect(
    "moves an existing default subscription to the new default while explicit subscriptions stay pinned and history does not replay",
    () =>
      Effect.gen(function* () {
        const bid = ProviderInstanceId.make("hermes-b");
        const { service, settings, directory, path, home } = yield* makeFixture(true, { id: bid });
        const aHome = path.join(directory, "hermes-a");
        yield* Effect.sync(() => {
          createHermesDeliveryFixture(aHome);
          appendHermesDeliveryFixture(home, { id: "b-history", startedAt: HISTORY_AT });
          appendHermesDeliveryFixture(aHome, { id: "a-history", startedAt: HISTORY_AT });
        });
        const events = yield* Stream.toQueue(yield* service.subscribe({}), {
          capacity: "unbounded",
        });
        const pinned = yield* Stream.toQueue(yield* service.subscribe({ instanceId: bid }), {
          capacity: "unbounded",
        });
        expect(yield* Queue.take(events)).toMatchObject({
          _tag: "snapshot",
          snapshot: { jobs: [{ runs: [{ id: "b-history" }] }] },
        });
        expect(yield* Queue.take(pinned)).toMatchObject({
          _tag: "snapshot",
          snapshot: { jobs: [{ runs: [{ id: "b-history" }] }] },
        });
        const current = yield* settings.getSettings;
        yield* settings.updateSettings({
          providerInstances: {
            ...current.providerInstances,
            [bid]: { ...current.providerInstances[bid]!, enabled: false },
            [instanceId]: {
              driver: ProviderDriverKind.make("hermes"),
              enabled: true,
              environment: providerEnvironment(aHome),
            },
          },
        });
        expect((yield* service.list({ refresh: true })).jobs[0]?.runs[0]?.id).toBe("a-history");
        yield* service.list({ instanceId: bid, refresh: true });
        expect(yield* Queue.take(events)).toMatchObject({
          _tag: "snapshot",
          snapshot: { availability: "ready", jobs: [{ runs: [{ id: "a-history" }] }] },
        });
        expect(yield* Queue.take(pinned)).toMatchObject({
          _tag: "snapshot",
          snapshot: { availability: "providerDisabled" },
        });
        // A mute snapshot is a FIFO barrier; historical completion events would appear first.
        const muted = yield* service.setMuted({ instanceId, jobId, muted: true });
        expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: muted });
        expect((yield* service.list({ refresh: true })).jobs[0]?.muted).toBe(true);
      }),
  );

  it.effect(
    "baselines a cached active target before attaching a default follower without dropping the explicit watcher's alerts",
    () =>
      Effect.gen(function* () {
        const aid = ProviderInstanceId.make("hermes-a");
        const { service, settings, directory, path, home } = yield* makeFixture();
        const aHome = path.join(directory, "hermes-a");
        yield* Effect.sync(() => {
          createHermesDeliveryFixture(aHome);
          appendHermesDeliveryFixture(home, { id: "b-history", startedAt: HISTORY_AT });
          appendHermesDeliveryFixture(aHome, { id: "a-history", startedAt: HISTORY_AT });
        });
        yield* settings.updateSettings({
          providerInstances: {
            ...(yield* settings.getSettings).providerInstances,
            [aid]: {
              driver: ProviderDriverKind.make("hermes"),
              enabled: true,
              environment: providerEnvironment(aHome),
            },
          },
        });
        const defaults = yield* Stream.toQueue(yield* service.subscribe({}), {
          capacity: "unbounded",
        });
        const explicit = yield* Stream.toQueue(yield* service.subscribe({ instanceId: aid }), {
          capacity: "unbounded",
        });
        expect(yield* Queue.take(defaults)).toMatchObject({
          _tag: "snapshot",
          snapshot: { jobs: [{ runs: [{ id: "b-history" }] }] },
        });
        expect(yield* Queue.take(explicit)).toMatchObject({
          _tag: "snapshot",
          snapshot: { jobs: [{ runs: [{ id: "a-history" }] }] },
        });
        yield* service.list({ instanceId: aid, refresh: true });
        yield* Effect.sync(() =>
          appendHermesDeliveryFixture(aHome, { id: "before-switch", startedAt: NEW_RUN_AT }),
        );
        const current = yield* settings.getSettings;
        yield* settings.updateSettings({
          providerInstances: {
            ...current.providerInstances,
            [instanceId]: { ...current.providerInstances[instanceId]!, enabled: false },
          },
        });
        expect(yield* Queue.take(defaults)).toMatchObject({
          _tag: "snapshot",
          snapshot: {
            availability: "ready",
            jobs: [{ runs: [{ id: "before-switch" }, { id: "a-history" }] }],
          },
        });
        // The existing explicit watcher receives the legitimate outstanding alert.
        expect(yield* Queue.take(explicit)).toMatchObject({
          _tag: "snapshot",
          snapshot: { jobs: [{ runs: [{ id: "before-switch" }, { id: "a-history" }] }] },
        });
        expect(yield* Queue.take(explicit)).toMatchObject({
          _tag: "runCompleted",
          run: { runId: "before-switch" },
        });
        yield* service.list({ instanceId: aid, refresh: true });
        yield* Effect.sync(() =>
          appendHermesDeliveryFixture(aHome, { id: "after-switch", startedAt: LATER_RUN_AT }),
        );
        yield* service.list({ instanceId: aid, refresh: true });
        for (const events of [defaults, explicit]) {
          expect(yield* Queue.take(events)).toMatchObject({
            _tag: "snapshot",
            snapshot: {
              jobs: [
                { runs: [{ id: "after-switch" }, { id: "before-switch" }, { id: "a-history" }] },
              ],
            },
          });
          expect(yield* Queue.take(events)).toMatchObject({
            _tag: "runCompleted",
            run: { runId: "after-switch" },
          });
        }
        const muted = yield* service.setMuted({ instanceId: aid, jobId, muted: true });
        expect(yield* Queue.take(defaults)).toEqual({ _tag: "snapshot", snapshot: muted });
        expect(yield* Queue.take(explicit)).toEqual({ _tag: "snapshot", snapshot: muted });
      }),
  );

  it.effect("isolates selected-profile cached jobs, output and notification mutes", () =>
    Effect.gen(function* () {
      const { service, settings, home, directory, path } = yield* makeFixture();
      const secondId = ProviderInstanceId.make("hermes-b");
      const secondHome = path.join(directory, "hermes-b");
      yield* Effect.sync(() => {
        createHermesDeliveryFixture(secondHome);
        appendHermesDeliveryFixture(home, {
          id: "a-run",
          content: "A output",
          startedAt: HISTORY_AT,
        });
        appendHermesDeliveryFixture(secondHome, {
          id: "b-run",
          content: "B output",
          startedAt: HISTORY_AT,
        });
      });
      const current = yield* settings.getSettings;
      yield* settings.updateSettings({
        providerInstances: {
          ...current.providerInstances,
          [secondId]: {
            driver: ProviderDriverKind.make("hermes"),
            enabled: true,
            environment: providerEnvironment(secondHome),
          },
        },
      });
      for (const [selected, runId, content] of [
        [instanceId, "a-run", "A output"],
        [secondId, "b-run", "B output"],
        [instanceId, "a-run", "A output"],
      ] as const) {
        expect((yield* service.list({ instanceId: selected })).jobs[0]?.runs[0]?.id).toBe(runId);
        expect((yield* service.getRunOutput({ instanceId: selected, jobId, runId })).content).toBe(
          content,
        );
      }
      yield* service.setMuted({ instanceId, jobId, muted: true });
      expect((yield* service.list({ instanceId })).jobs[0]?.muted).toBe(true);
      expect((yield* service.list({ instanceId: secondId, refresh: true })).jobs[0]?.muted).toBe(
        false,
      );
      expect(
        (yield* service.list({ instanceId: ProviderInstanceId.make("missing") })).availability,
      ).toBe("providerDisabled");
    }),
  );

  it.effect("keeps snapshots preview-only and fetches separately bounded full output", () =>
    Effect.gen(function* () {
      const { service, home } = yield* makeFixture();
      const content = `## Digest\n\n${"A useful result. ".repeat(100)}`;
      const oversized = "x".repeat(HERMES_CRON_OUTPUT_LENGTH + 100);
      yield* Effect.sync(() => {
        appendHermesDeliveryFixture(home, { id: "report", content, startedAt: HISTORY_AT });
        appendHermesDeliveryFixture(home, {
          id: "oversized",
          content: oversized,
          startedAt: NEW_RUN_AT,
        });
      });

      const snapshot = yield* service.list({ refresh: true });
      expect(snapshot).toMatchObject({ availability: "ready", runHistoryAvailable: true });
      expect(snapshot.jobs[0]?.runs.map((run) => run.id)).toEqual(["oversized", "report"]);
      for (const run of snapshot.jobs[0]!.runs) {
        expect(run.delivery).toMatchObject({
          source: "session",
          status: "delivered",
          contentAvailable: true,
          truncated: true,
        });
        expect(run.delivery?.preview).toHaveLength(HERMES_CRON_PREVIEW_LENGTH);
      }
      expect(encodeSnapshot(snapshot)).not.toContain(content);
      expect(encodeSnapshot(snapshot)).not.toContain(oversized);
      expect(yield* service.getRunOutput({ jobId, runId: "report" })).toEqual({
        content,
        truncated: false,
        source: "session",
      });
      expect(yield* service.getRunOutput({ jobId, runId: "oversized" })).toEqual({
        content: oversized.slice(0, HERMES_CRON_OUTPUT_LENGTH),
        truncated: true,
        source: "session",
      });
      expect(yield* service.list({})).toEqual(snapshot);
    }),
  );

  it.effect(
    "starts with a snapshot, never announces history, and notifies once per new completion",
    () =>
      Effect.gen(function* () {
        const { service, home } = yield* makeFixture();
        yield* Effect.sync(() =>
          appendHermesDeliveryFixture(home, { id: "history", startedAt: HISTORY_AT }),
        );
        const events = yield* Stream.toQueue(yield* service.subscribe({}), {
          capacity: "unbounded",
        });
        expect(yield* Queue.take(events)).toMatchObject({
          _tag: "snapshot",
          snapshot: { jobs: [{ runs: [{ id: "history" }] }] },
        });

        const content = "New completed report. ".repeat(100);
        yield* Effect.sync(() =>
          appendHermesDeliveryFixture(home, { id: "new-run", content, startedAt: NEW_RUN_AT }),
        );
        const snapshot = yield* service.list({ refresh: true });
        expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot });
        expect(yield* Queue.take(events)).toMatchObject({
          _tag: "runCompleted",
          run: {
            jobId,
            runId: "new-run",
            status: "completed",
            finishedAt: "2026-08-01T09:00:30.000Z",
            delivery: {
              preview: content.slice(0, HERMES_CRON_PREVIEW_LENGTH),
              truncated: true,
              source: "session",
              status: "delivered",
            },
          },
        });
        yield* service.list({ refresh: true });
        yield* service.list({ refresh: true });
        // A later snapshot is a FIFO barrier: duplicate snapshots/completions
        // would arrive before it, without timing-based assertions of silence.
        const muted = yield* service.setMuted({ jobId, muted: true });
        expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: muted });
      }),
  );

  it.effect(
    "updates muted history without notifications and resumes for future failures after unmuting",
    () =>
      Effect.gen(function* () {
        const { service, home } = yield* makeFixture();
        const events = yield* Stream.toQueue(yield* service.subscribe({}), {
          capacity: "unbounded",
        });
        expect(yield* Queue.take(events)).toMatchObject({ _tag: "snapshot" });
        const muted = yield* service.setMuted({ jobId, muted: true });
        expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: muted });

        yield* Effect.sync(() =>
          appendHermesDeliveryFixture(home, { id: "muted-run", startedAt: HISTORY_AT }),
        );
        const snapshot = yield* service.list({ refresh: true });
        expect(snapshot.jobs[0]).toMatchObject({ muted: true, runs: [{ id: "muted-run" }] });
        expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot });
        const unmuted = yield* service.setMuted({ jobId, muted: false });
        expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: unmuted });

        yield* Effect.sync(() =>
          appendHermesDeliveryFixture(home, {
            id: "failed-run",
            status: "failed",
            deliveryStatus: "pending",
            content: "Credentials need attention.",
            startedAt: NEW_RUN_AT,
          }),
        );
        const failed = yield* service.list({ refresh: true });
        expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: failed });
        expect(yield* Queue.take(events)).toMatchObject({
          _tag: "runCompleted",
          run: {
            runId: "failed-run",
            status: "failed",
            error: "Provider timeout",
            delivery: { preview: "Credentials need attention.", source: "delivery" },
          },
        });
      }),
  );

  it.effect("resets history and cached output when the configured Hermes home changes", () =>
    Effect.gen(function* () {
      const { service, settings, home, directory, path } = yield* makeFixture();
      yield* Effect.sync(() =>
        appendHermesDeliveryFixture(home, {
          id: "same-id",
          status: "failed",
          deliveryStatus: "pending",
          content: "Only belongs to the first home.",
          startedAt: HISTORY_AT,
        }),
      );
      const events = yield* Stream.toQueue(yield* service.subscribe({}), { capacity: "unbounded" });
      expect(yield* Queue.take(events)).toMatchObject({ _tag: "snapshot" });
      expect(yield* service.getRunOutput({ jobId, runId: "same-id" })).toMatchObject({
        content: "Only belongs to the first home.",
      });

      const otherHome = path.join(directory, "other-hermes");
      yield* Effect.sync(() => {
        createHermesDeliveryFixture(otherHome);
        appendHermesDeliveryFixture(otherHome, {
          id: "same-id",
          status: "failed",
          startedAt: HISTORY_AT,
        });
        appendHermesDeliveryFixture(otherHome, {
          id: "other-history",
          content: "This is the second home's report.",
          startedAt: NEW_RUN_AT,
        });
      });
      yield* settings.updateSettings({
        providerInstances: {
          [instanceId]: {
            ...(yield* settings.getSettings).providerInstances[instanceId]!,
            environment: providerEnvironment(otherHome),
          },
        },
      });
      const snapshot = yield* service.list({ refresh: true });
      expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot });
      expect(yield* service.getRunOutput({ jobId, runId: "same-id" })).toEqual({
        content: null,
        truncated: false,
        source: null,
      });
      expect(yield* service.getRunOutput({ jobId, runId: "other-history" })).toMatchObject({
        content: "This is the second home's report.",
        source: "session",
      });
      const muted = yield* service.setMuted({ jobId, muted: true });
      expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: muted });
    }),
  );

  it.effect("treats runs observed after re-enabling as history, not new completions", () =>
    Effect.gen(function* () {
      const { service, settings, home } = yield* makeFixture();
      yield* Effect.sync(() =>
        appendHermesDeliveryFixture(home, { id: "history", startedAt: HISTORY_AT }),
      );
      const events = yield* Stream.toQueue(yield* service.subscribe({}), { capacity: "unbounded" });
      expect(yield* Queue.take(events)).toMatchObject({ _tag: "snapshot" });
      yield* settings.updateSettings({
        providerInstances: {
          [instanceId]: {
            ...(yield* settings.getSettings).providerInstances[instanceId]!,
            enabled: false,
          },
        },
      });
      const disabled = yield* service.list({ refresh: true });
      expect(disabled).toMatchObject({ availability: "providerDisabled", jobs: [] });
      expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: disabled });
      expect(
        yield* service.getRunOutput({ jobId, runId: "history" }).pipe(Effect.flip),
      ).toMatchObject({
        reason: "providerDisabled",
      });
      yield* Effect.sync(() =>
        appendHermesDeliveryFixture(home, { id: "while-disabled", startedAt: NEW_RUN_AT }),
      );
      yield* settings.updateSettings({
        providerInstances: {
          [instanceId]: {
            ...(yield* settings.getSettings).providerInstances[instanceId]!,
            enabled: true,
          },
        },
      });
      const enabled = yield* service.list({ refresh: true });
      expect(enabled.jobs[0]?.runs.map((run) => run.id)).toEqual(["while-disabled", "history"]);
      expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: enabled });

      yield* Effect.sync(() =>
        appendHermesDeliveryFixture(home, { id: "after-enabling", startedAt: LATER_RUN_AT }),
      );
      const next = yield* service.list({ refresh: true });
      expect(yield* Queue.take(events)).toEqual({ _tag: "snapshot", snapshot: next });
      expect(yield* Queue.take(events)).toMatchObject({
        _tag: "runCompleted",
        run: { runId: "after-enabling" },
      });
    }),
  );

  it.effect("rejects unknown runs and runs belonging to a different job", () =>
    Effect.gen(function* () {
      const { service, home } = yield* makeFixture();
      yield* Effect.sync(() =>
        appendHermesDeliveryFixture(home, { id: "known-run", startedAt: HISTORY_AT }),
      );
      for (const input of [
        { jobId, runId: "missing-run" },
        { jobId: HermesCronJobId.make("another-job"), runId: "known-run" },
      ]) {
        expect(yield* service.getRunOutput(input).pipe(Effect.flip)).toMatchObject({
          _tag: "HermesCronError",
          reason: "unknownJob",
        });
      }
    }),
  );

  it.effect("reports an absent store without creating Hermes files on read-only requests", () =>
    Effect.gen(function* () {
      const { service, home, fs } = yield* makeFixture();
      yield* fs.remove(home, { recursive: true });
      expect(yield* service.list({ refresh: true })).toMatchObject({
        availability: "noCronStore",
        runHistoryAvailable: false,
        jobs: [],
      });
      expect(
        yield* service.getRunOutput({ jobId, runId: "missing" }).pipe(Effect.flip),
      ).toMatchObject({
        reason: "unreadable",
      });
      expect(yield* fs.exists(home)).toBe(false);
    }),
  );

  it.effect(
    "returns disabled availability and rejects output and mutations without touching Hermes",
    () =>
      Effect.gen(function* () {
        const { service, home, fs } = yield* makeFixture(false);
        yield* fs.remove(home, { recursive: true });
        expect(yield* service.list({ refresh: true })).toMatchObject({
          availability: "providerDisabled",
          runHistoryAvailable: false,
          jobs: [],
        });
        for (const request of [
          service.getRunOutput({ jobId, runId: "missing" }).pipe(Effect.asVoid),
          service.setMuted({ jobId, muted: true }).pipe(Effect.asVoid),
          service.setEnabled({ jobId, enabled: true }).pipe(Effect.asVoid),
        ]) {
          expect(yield* request.pipe(Effect.flip)).toMatchObject({
            _tag: "HermesCronError",
            reason: "providerDisabled",
          });
        }
        expect(yield* fs.exists(home)).toBe(false);
      }),
  );
});
