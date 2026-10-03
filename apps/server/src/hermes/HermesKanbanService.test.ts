import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, describe } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Effect, FileSystem, Layer } from "effect";
import * as ServerSettings from "../serverSettings.ts";
import * as HermesKanbanService from "./HermesKanbanService.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kanban-service-" });
  const binary = `${root}/hermes`;
  const log = `${root}/calls.jsonl`;
  yield* fs.writeFileString(
    binary,
    `#!/usr/bin/env node
const fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(process.env.KANBAN_TEST_LOG, JSON.stringify(args)+'\\n');
if(args.includes('boards')) console.log(JSON.stringify([{slug:'default',name:null,is_current:true}]));
else if(args.includes('list')) console.log(JSON.stringify([]));
else if(args.includes('create')) { if(args[args.indexOf('--initial-status')+1]!=='blocked') process.exit(5); const body=fs.readFileSync(args[args.indexOf('--body-file')+1],'utf8');fs.writeFileSync(process.env.KANBAN_TEST_BODY,body);console.log('{}'); }
else if(args.includes('complete')) { const result=args.find(a=>a.startsWith('--result='))?.slice('--result='.length); if(!result?.trim()) { console.error('completion blocked: no result or summary evidence');process.exit(2); } if(result==='refuse') process.exit(3); if(result!=='silent refusal') fs.writeFileSync(process.env.KANBAN_TEST_BODY,result); }
else if(args.includes('show')) console.log(JSON.stringify({task:{id:'t1',title:'Test',status:fs.existsSync(process.env.KANBAN_TEST_BODY)?'done':'blocked',assignee:null},latest_summary:null,parents:[],children:[],comments:[]}));
`,
  );
  yield* fs.chmod(binary, 0o700);
  const instanceId = ProviderInstanceId.make("hermes-test");
  const settings = ServerSettings.layerTest({
    providerInstances: {
      [instanceId]: {
        driver: ProviderDriverKind.make("hermes"),
        enabled: true,
        config: { binaryPath: binary },
        environment: [
          { name: "KANBAN_TEST_LOG", value: log, sensitive: false },
          { name: "KANBAN_TEST_BODY", value: `${root}/body`, sensitive: false },
        ],
      },
    },
  });
  return {
    fs,
    root,
    log,
    instanceId,
    layer: HermesKanbanService.layer.pipe(Layer.provide(settings)),
  };
});

describe("HermesKanbanService", () => {
  it.effect(
    "creates only confirmed blocked drafts with body-file text preserved and refuses missing instance fallback",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        yield* Effect.gen(function* () {
          const service = yield* HermesKanbanService.HermesKanbanService;
          const input = {
            instanceId: h.instanceId,
            board: "default",
            taskId: "new",
            action: "create" as const,
            confirmed: false,
            title: "A draft",
            body: "Line one\n--flag\nÉ",
          };
          expect((yield* service.mutate(input).pipe(Effect.flip)).detail).toContain("Confirm");
          expect(yield* h.fs.exists(h.log)).toBe(false);
          yield* service.mutate({ ...input, confirmed: true });
          expect(yield* h.fs.readFileString(`${h.root}/body`)).toBe(input.body);
          expect(
            (yield* service
              .list({ instanceId: ProviderInstanceId.make("missing") })
              .pipe(Effect.flip)).detail,
          ).toContain("missing or disabled");
          const calls = (yield* h.fs.readFileString(h.log))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(calls[0]).toContain("blocked");
          expect(
            calls.every((args) => !args.includes("dispatch") && !args.includes("daemon")),
          ).toBe(true);
        }).pipe(Effect.provide(h.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("rejects CLI flag injection and refuses deletion of unarchived cards", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* HermesKanbanService.HermesKanbanService;
        expect(
          (yield* service
            .get({ instanceId: h.instanceId, board: "default", taskId: "--help" })
            .pipe(Effect.flip)).detail,
        ).toContain("identifier");
        expect(yield* h.fs.exists(h.log)).toBe(false);
        expect(
          (yield* service
            .mutate({
              instanceId: h.instanceId,
              board: "default",
              taskId: "t1",
              action: "delete",
              confirmed: true,
            })
            .pipe(Effect.flip)).detail,
        ).toContain("Archive");
        const calls = yield* h.fs.readFileString(h.log);
        expect(calls).not.toContain("--rm");
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Kanban completion evidence", () => {
  it.effect("rejects blank results before invoking Hermes and preserves the supplied result", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* HermesKanbanService.HermesKanbanService;
        const input = {
          instanceId: h.instanceId,
          board: "default",
          taskId: "t1",
          action: "complete" as const,
          confirmed: true,
        };
        for (const result of [undefined, "", " \n\t"]) {
          expect(
            (yield* service
              .mutate({ ...input, ...(result === undefined ? {} : { result }) })
              .pipe(Effect.flip)).detail,
          ).toContain("result");
        }
        expect(yield* h.fs.exists(h.log)).toBe(false);
        const result = "--Verified the change\nÉvidence: focused checks passed.";
        yield* service.mutate({ ...input, result });
        expect(yield* h.fs.readFileString(`${h.root}/body`)).toBe(result);
        const calls = (yield* h.fs.readFileString(h.log))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((args) => args.includes("complete"))).toEqual([
          ["kanban", "--board", "default", "complete", "t1", `--result=${result}`],
        ]);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "returns failure without refreshing a success snapshot when Hermes refuses completion",
    () =>
      Effect.gen(function* () {
        for (const result of ["refuse", "silent refusal"]) {
          const h = yield* fixture;
          yield* Effect.gen(function* () {
            const service = yield* HermesKanbanService.HermesKanbanService;
            const error = yield* service
              .mutate({
                instanceId: h.instanceId,
                board: "default",
                taskId: "t1",
                action: "complete",
                confirmed: true,
                result,
              })
              .pipe(Effect.flip);
            expect(error.detail).toContain(result === "refuse" ? "exit 3" : "did not complete");
            const calls = yield* h.fs.readFileString(h.log);
            expect(calls).not.toContain('"list"');
            expect(yield* h.fs.exists(`${h.root}/body`)).toBe(false);
          }).pipe(Effect.provide(h.layer));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
