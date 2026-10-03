import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HermesInstanceScope } from "./hermesInstance.ts";

export const HermesKanbanStatus = Schema.Literals([
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "archived",
]);
export type HermesKanbanStatus = typeof HermesKanbanStatus.Type;
export const HermesKanbanBoard = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  is_current: Schema.Boolean,
});
export const HermesKanbanTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  status: HermesKanbanStatus,
  assignee: Schema.NullOr(Schema.String),
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  result: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type HermesKanbanTask = typeof HermesKanbanTask.Type;
export const HermesKanbanDetail = Schema.Struct({
  task: HermesKanbanTask,
  latest_summary: Schema.NullOr(Schema.String),
  parents: Schema.Array(Schema.String),
  children: Schema.Array(Schema.String),
  comments: Schema.Array(
    Schema.Struct({
      author: Schema.NullOr(Schema.String),
      body: Schema.String,
      created_at: Schema.Number,
    }),
  ),
});
export type HermesKanbanDetail = typeof HermesKanbanDetail.Type;
export const HermesKanbanListInput = Schema.Struct({
  ...HermesInstanceScope.fields,
  board: Schema.optionalKey(TrimmedNonEmptyString),
});
export const HermesKanbanSnapshot = Schema.Struct({
  boards: Schema.Array(HermesKanbanBoard),
  board: TrimmedNonEmptyString,
  tasks: Schema.Array(HermesKanbanTask),
});
export type HermesKanbanSnapshot = typeof HermesKanbanSnapshot.Type;
export const HermesKanbanGetInput = Schema.Struct({
  ...HermesInstanceScope.fields,
  board: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
});
export const HermesKanbanMutateInput = Schema.Struct({
  ...HermesKanbanGetInput.fields,
  action: Schema.Literals([
    "create",
    "comment",
    "block",
    "schedule",
    "promote",
    "unblock",
    "complete",
    "archive",
    "delete",
  ]),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262144))),
  assignee: Schema.optionalKey(TrimmedNonEmptyString),
  result: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262144))),
  confirmed: Schema.Boolean,
});
export type HermesKanbanListInput = typeof HermesKanbanListInput.Type;
export type HermesKanbanGetInput = typeof HermesKanbanGetInput.Type;
export type HermesKanbanMutateInput = typeof HermesKanbanMutateInput.Type;
export class HermesKanbanError extends Schema.TaggedError<HermesKanbanError>()(
  "HermesKanbanError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}
