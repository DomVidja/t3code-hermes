import { useState } from "react";
import type {
  EnvironmentId,
  HermesKanbanMutateInput,
  HermesKanbanTask,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useHermesEnvironmentId } from "../../state/hermesCron";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const STATUSES = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "archived",
] as const;
const ACTION_LABELS = {
  create: "Create blocked draft",
  comment: "Add comment",
  block: "Block",
  schedule: "Schedule",
  promote: "Promote to ready",
  unblock: "Unblock / unschedule",
  complete: "Mark complete",
  archive: "Archive",
  delete: "Permanently delete",
} as const;

/** Web and desktop board; all storage and actions belong to the connected Hermes host. */
export function HermesKanbanTab({
  instanceId,
  environmentId: targetEnvironmentId,
}: {
  readonly instanceId?: ProviderInstanceId;
  readonly environmentId?: EnvironmentId | null;
}) {
  const automaticEnvironmentId = useHermesEnvironmentId();
  const environmentId =
    targetEnvironmentId === undefined ? automaticEnvironmentId : targetEnvironmentId;
  // A changed target remounts all local drafts and selections; stale actions cannot cross profiles.
  return (
    <KanbanBoard
      key={`${environmentId}:${instanceId ?? "default"}`}
      environmentId={environmentId}
      instanceId={instanceId}
    />
  );
}

function KanbanBoard({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | undefined;
}) {
  const [board, setBoard] = useState<string>();
  const [taskId, setTaskId] = useState<string>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [completionResult, setCompletionResult] = useState("");
  const [action, setAction] = useState<HermesKanbanMutateInput["action"]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = instanceId === undefined ? {} : { instanceId };
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.hermesKanbanList({
          environmentId,
          input: { ...scope, ...(board ? { board } : {}) },
        }),
  );
  const selectedBoard = query.data?.board;
  const detail = useEnvironmentQuery(
    environmentId === null || !taskId || !selectedBoard
      ? null
      : serverEnvironment.hermesKanbanGet({
          environmentId,
          input: { ...scope, board: selectedBoard, taskId },
        }),
  );
  const mutate = useAtomCommand(serverEnvironment.hermesKanbanMutate, { reportFailure: false });
  const submit = async () => {
    if (environmentId === null || !selectedBoard || !action) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        environmentId,
        input: {
          ...scope,
          board: selectedBoard,
          taskId: taskId ?? "new",
          action,
          confirmed: true,
          title,
          body,
          ...(action === "complete" ? { result: completionResult } : {}),
          ...(assignee.trim() ? { assignee: assignee.trim() } : {}),
        },
      });
      if (result._tag !== "Success") {
        setError(formatEnvironmentQueryError(result.cause));
        return;
      }
      setAction(undefined);
      setBody("");
      setCompletionResult("");
      if (action === "create") setTitle("");
      if (action === "delete" || action === "archive") setTaskId(undefined);
      query.refresh();
      detail.refresh();
    } finally {
      setBusy(false);
    }
  };
  const selectedTask = detail.data?.task;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Hermes owns these boards. Refreshing recalculates dependency readiness; a running Hermes
        gateway may pick up ready assigned cards. New drafts stay blocked.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">
          Board{" "}
          <select
            aria-label="Kanban board"
            value={selectedBoard ?? ""}
            disabled={busy || !query.data}
            onChange={(event) => {
              setBoard(event.target.value);
              setTaskId(undefined);
              setAction(undefined);
            }}
            className="rounded border bg-background p-1"
          >
            {query.data?.boards.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name || item.slug}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || environmentId === null}
          onClick={query.refresh}
        >
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !query.data}
          onClick={() => {
            setTaskId(undefined);
            setBody("");
            setAction("create");
          }}
        >
          New draft
        </Button>
      </div>
      {environmentId === null ? <p>Enable a Hermes instance to open its boards.</p> : null}
      {query.isPending && !query.data ? <p>Loading Hermes boards…</p> : null}
      {(error ?? query.error ?? detail.error) ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error ?? detail.error}
        </p>
      ) : null}
      {query.data ? (
        <div className="overflow-x-auto">
          <div className="flex gap-3">
            {STATUSES.map((status) => (
              <section key={status} className="min-w-48 flex-1 rounded-lg border p-2">
                <h3 className="mb-2 text-sm font-medium capitalize">{status}</h3>
                <ul className="space-y-2">
                  {(query.data?.tasks ?? [])
                    .filter((task) => task.status === status)
                    .map((task: HermesKanbanTask) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          className="w-full rounded border p-2 text-left text-sm"
                          onClick={() => {
                            setTaskId(task.id);
                            setBody("");
                            setAction(undefined);
                          }}
                        >
                          <span className="block font-medium">{task.title}</span>
                          <span className="text-xs text-muted-foreground">
                            {task.id} · {task.assignee ?? "Unassigned"}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ) : null}
      {detail.isPending ? (
        <p>Loading task…</p>
      ) : selectedTask ? (
        <section className="space-y-2 rounded-lg border p-3">
          <h3 className="font-medium">{selectedTask.title}</h3>
          <p className="text-xs text-muted-foreground">
            {selectedTask.id} · {selectedTask.status} · {selectedTask.assignee ?? "Unassigned"}
          </p>
          <p className="whitespace-pre-wrap text-sm">{selectedTask.body}</p>
          {selectedTask.result ? (
            <p className="whitespace-pre-wrap text-sm">Result: {selectedTask.result}</p>
          ) : null}
          {detail.data?.latest_summary ? (
            <p className="whitespace-pre-wrap text-sm">{detail.data.latest_summary}</p>
          ) : null}
          <p className="text-xs">
            Parents: {detail.data?.parents.join(", ") || "None"} · Children:{" "}
            {detail.data?.children.join(", ") || "None"}
          </p>
          <ul>
            {detail.data?.comments.map((comment) => (
              <li
                key={`${comment.created_at}:${comment.author}:${comment.body}`}
                className="my-2 whitespace-pre-wrap text-sm"
              >
                <span className="font-medium">{comment.author ?? "User"}: </span>
                {comment.body}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {(selectedTask.status === "archived"
              ? (["delete"] as const)
              : ([
                  "comment",
                  "block",
                  "schedule",
                  "promote",
                  "unblock",
                  "complete",
                  "archive",
                ] as const)
            ).map((name) => (
              <Button
                key={name}
                variant="outline"
                size="sm"
                disabled={busy || selectedTask.status === "running"}
                onClick={() => {
                  setCompletionResult("");
                  setAction(name);
                }}
              >
                {ACTION_LABELS[name]}
              </Button>
            ))}
          </div>
        </section>
      ) : null}
      {action ? (
        <form
          className="space-y-3 rounded-lg border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h3 className="font-medium">{ACTION_LABELS[action]}</h3>
          {action === "create" ? (
            <>
              <Input
                aria-label="Task title"
                placeholder="Task title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={busy}
              />
              <Input
                aria-label="Assignee profile"
                placeholder="Assignee profile (optional)"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                disabled={busy}
              />
            </>
          ) : null}
          {action === "create" || action === "comment" ? (
            <Textarea
              aria-label="Task text"
              placeholder={action === "create" ? "Task description" : "Comment"}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              disabled={busy}
            />
          ) : null}
          {action === "complete" ? (
            <label className="block space-y-1 text-sm">
              <span>Completion result</span>
              <Textarea
                aria-label="Completion result"
                placeholder="Describe what was done and how it was verified."
                value={completionResult}
                onChange={(event) => setCompletionResult(event.target.value)}
                maxLength={262144}
                required
                disabled={busy}
              />
            </label>
          ) : null}
          <p className="text-sm">
            {action === "promote" || action === "unblock"
              ? "Promoting to ready allows the existing Hermes gateway to run this card using its assigned profile."
              : action === "archive"
                ? "Archiving removes this card from active work and may stop a worker if execution starts before this change finishes."
                : action === "complete"
                  ? "Record the completed work and its verification. Hermes may reject unmet requirements. Accepted completion may make dependent cards ready for the existing Hermes gateway."
                  : action === "create"
                    ? "This creates a blocked card. Promote it separately when you are ready for execution."
                    : `Confirm ${ACTION_LABELS[action].toLowerCase()} for this card.`}
          </p>
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={
                busy ||
                (action === "create" && !title.trim()) ||
                (action === "comment" && !body.trim()) ||
                (action === "complete" && !completionResult.trim())
              }
            >
              {busy ? "Saving…" : "Confirm"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setAction(undefined)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
