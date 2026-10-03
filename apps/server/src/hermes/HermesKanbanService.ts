import {
  HermesKanbanBoard,
  HermesKanbanError,
  HermesKanbanSnapshot,
  HermesKanbanDetail,
  type HermesKanbanListInput,
  type HermesKanbanGetInput,
  type HermesKanbanMutateInput,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance } from "./hermesCronState.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";

const decodeBoards = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(HermesKanbanBoard)),
);
const decodeTasks = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HermesKanbanSnapshot.fields.tasks),
);
const decodeDetail = Schema.decodeUnknownEffect(Schema.fromJsonString(HermesKanbanDetail));

export class HermesKanbanService extends Context.Service<
  HermesKanbanService,
  {
    readonly list: (
      input: HermesKanbanListInput,
    ) => Effect.Effect<typeof HermesKanbanSnapshot.Type, HermesKanbanError>;
    readonly get: (
      input: HermesKanbanGetInput,
    ) => Effect.Effect<typeof HermesKanbanDetail.Type, HermesKanbanError>;
    readonly mutate: (
      input: HermesKanbanMutateInput,
    ) => Effect.Effect<typeof HermesKanbanSnapshot.Type, HermesKanbanError>;
  }
>()("t3-hermes/hermes/HermesKanbanService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const resolve = Effect.fnUntraced(function* (input: HermesKanbanListInput) {
    const current = yield* settings.getSettings;
    const instance = resolveEnabledHermesInstance(current, input.instanceId);
    if (instance === null)
      return yield* new HermesKanbanError({
        detail: "The selected Hermes instance is missing or disabled.",
      });
    return {
      binary: instance.settings.binaryPath || "hermes",
      env: mergeProviderInstanceEnvironment(instance.environment),
    };
  });
  const run = Effect.fnUntraced(function* (input: HermesKanbanListInput, args: readonly string[]) {
    if (input.board !== undefined && (input.board.startsWith("-") || /[\r\n\0]/.test(input.board)))
      return yield* new HermesKanbanError({ detail: "Invalid Kanban board." });
    const instance = yield* resolve(input);
    const command = yield* resolveSpawnCommand(instance.binary, ["kanban", ...args], {
      env: instance.env,
    });
    const output = yield* spawnAndCollect(
      instance.binary,
      ChildProcess.make(command.command, command.args, { env: instance.env, shell: command.shell }),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.scoped);
    if (output.code !== 0)
      return yield* new HermesKanbanError({
        detail: `Hermes Kanban command failed (exit ${output.code}).`,
      });
    return output.stdout;
  });
  const list = Effect.fnUntraced(
    function* (input: HermesKanbanListInput) {
      const boards = yield* run(input, ["boards", "list", "--json"]).pipe(
        Effect.flatMap(decodeBoards),
      );
      const board = input.board ?? boards.find((item) => item.is_current)?.slug ?? "default";
      if (!boards.some((item) => item.slug === board))
        return yield* new HermesKanbanError({ detail: "That board no longer exists." });
      const tasks = yield* run(input, ["--board", board, "list", "--archived", "--json"]).pipe(
        Effect.flatMap(decodeTasks),
      );
      return { boards, board, tasks };
    },
    Effect.mapError((cause) =>
      Schema.is(HermesKanbanError)(cause)
        ? cause
        : new HermesKanbanError({ detail: "Could not read Hermes Kanban boards.", cause }),
    ),
  );
  const get = Effect.fnUntraced(
    function* (input: HermesKanbanGetInput) {
      if (input.taskId.startsWith("-") || /[\r\n\0]/.test(input.taskId))
        return yield* new HermesKanbanError({ detail: "Invalid Kanban task identifier." });
      return yield* run(input, ["--board", input.board, "show", input.taskId, "--json"]).pipe(
        Effect.flatMap(decodeDetail),
      );
    },
    Effect.mapError((cause) =>
      Schema.is(HermesKanbanError)(cause)
        ? cause
        : new HermesKanbanError({ detail: "Could not read that Kanban task.", cause }),
    ),
  );
  const mutate = Effect.fnUntraced(
    function* (input: HermesKanbanMutateInput) {
      if (!input.confirmed)
        return yield* new HermesKanbanError({
          detail: "Confirm this Kanban change before continuing.",
        });
      if (
        [input.board, input.taskId, input.assignee ?? ""].some(
          (value) => value.startsWith("-") || /[\r\n\0]/.test(value),
        )
      )
        return yield* new HermesKanbanError({ detail: "Invalid Kanban identifier." });
      if (input.action === "complete" && (!input.result?.trim() || input.result.includes("\0")))
        return yield* new HermesKanbanError({
          detail: "Enter a completion result describing what was done and verified.",
        });
      if (input.action === "create") {
        if (!input.title?.trim() || input.title.startsWith("-"))
          return yield* new HermesKanbanError({
            detail: "Enter a task title that does not begin with a dash.",
          });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kanban-" });
            const file = `${dir}/body.txt`;
            yield* fs.writeFileString(file, input.body ?? "");
            yield* run(input, [
              "--board",
              input.board,
              "create",
              input.title!,
              "--initial-status",
              "blocked",
              "--body-file",
              file,
              "--json",
              ...(input.assignee ? ["--assignee", input.assignee] : []),
            ]);
          }),
        );
      } else {
        const detail = yield* get(input);
        if (detail.task.status === "running" && input.action !== "comment")
          return yield* new HermesKanbanError({
            detail: "Wait for the active worker before changing this task.",
          });
        if (input.action === "delete" && detail.task.status !== "archived")
          return yield* new HermesKanbanError({
            detail: "Archive the task before permanently deleting it.",
          });
        const args =
          input.action === "delete"
            ? ["archive", "--rm", input.taskId]
            : input.action === "comment"
              ? ["comment", input.taskId, "--", input.body ?? ""]
              : input.action === "complete"
                ? ["complete", input.taskId, `--result=${input.result}`]
                : [input.action, input.taskId];
        yield* run(input, ["--board", input.board, ...args]);
        if (input.action === "complete") {
          const updated = yield* get(input);
          if (updated.task.status !== "done")
            return yield* new HermesKanbanError({
              detail: `Hermes did not complete this task (current status: ${updated.task.status}). Refresh and check its completion requirements.`,
            });
        }
      }
      return yield* list(input);
    },
    Effect.mapError((cause) =>
      Schema.is(HermesKanbanError)(cause)
        ? cause
        : new HermesKanbanError({ detail: "Could not update that Kanban task.", cause }),
    ),
  );
  return HermesKanbanService.of({ list, get, mutate });
});
export const layer = Layer.effect(HermesKanbanService, make);
export const layerTest = Layer.succeed(
  HermesKanbanService,
  HermesKanbanService.of({
    list: () => Effect.succeed({ boards: [], board: "default", tasks: [] }),
    get: () => Effect.fail(new HermesKanbanError({ detail: "No task." })),
    mutate: () => Effect.fail(new HermesKanbanError({ detail: "Hermes disabled." })),
  }),
);
