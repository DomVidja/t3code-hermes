/**
 * Tasks tab — Hermes's own scheduled jobs.
 *
 * Read-mostly by design. Creating and editing tasks stays in chat, so the only
 * controls here are the two reversible ones: pause/resume and mute/unmute.
 * Opening a finished run shows the document Hermes saved for it.
 *
 * The component is deliberately dumb; everything that decides anything lives in
 * `useHermesCron` and the client-runtime fold behind it.
 */
import {
  describeHermesJobStatus,
  describeHermesJobSummary,
  formatHermesRunDuration,
  formatHermesTimestamp,
  type HermesCronStatusTone,
} from "@t3tools/client-runtime/state/hermes-cron";
import type { HermesCronJob, HermesCronJobId, HermesCronRun } from "@t3tools/contracts";
import {
  BellIcon,
  BellOffIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "../../lib/utils";
import { useHermesCron, useHermesRunOutput } from "../../state/hermesCron";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface HermesTasksTabProps {
  /** Closes the panel and drops a scheduling prompt into the composer. */
  readonly onNewTask: () => void;
}

const CHIP_CLASSES: Record<HermesCronStatusTone, string> = {
  ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  paused: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  idle: "bg-muted text-muted-foreground",
};

function StatusChip({ job }: { readonly job: HermesCronJob }) {
  const { tone, label } = describeHermesJobStatus(job);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        CHIP_CLASSES[tone],
      )}
    >
      {label}
    </span>
  );
}

function RunOutput({ run }: { readonly run: HermesCronRun }) {
  const { document, truncated, isPending, error } = useHermesRunOutput(run.jobId, run.id);
  if (error !== null) {
    return <p className="text-xs text-destructive">{error}</p>;
  }
  if (isPending) {
    return <Skeleton className="h-4 w-48" />;
  }
  if (document === null) {
    return (
      <p className="text-xs text-muted-foreground">Hermes kept no saved output for this run.</p>
    );
  }
  return (
    <div className="max-h-96 overflow-y-auto rounded-md border border-border/60 px-3 py-2">
      {document.length === 0 ? (
        truncated ? null : (
          <p className="text-xs text-muted-foreground">This run produced no output.</p>
        )
      ) : (
        <ChatMarkdown text={document} cwd={undefined} parseRawHtml={false} />
      )}
      {truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Output truncated. The full document is in the Hermes cron output directory.
        </p>
      ) : null}
    </div>
  );
}

function RunRow({ run }: { readonly run: HermesCronRun }) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const when = formatHermesTimestamp(run.finishedAt ?? run.startedAt ?? run.claimedAt);
  const duration = formatHermesRunDuration(run.durationMs);
  // Hermes saves the document as the run ends, so an unfinished run has none.
  const hasOutput = run.finishedAt !== null;
  const summary = (
    <>
      {hasOutput ? (
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
        />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span
        className={cn(
          "font-medium",
          run.status === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {run.status}
      </span>
      {when === null ? null : <span className="text-muted-foreground">{when}</span>}
      {duration === null ? null : <span className="text-muted-foreground">· {duration}</span>}
    </>
  );
  return (
    <li className="flex flex-col gap-0.5 border-t border-border/40 py-1.5 text-xs">
      {hasOutput ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="flex items-center gap-2 text-left"
        >
          {summary}
        </button>
      ) : (
        <div className="flex items-center gap-2">{summary}</div>
      )}
      {run.error === null ? null : (
        <p className="break-words font-mono text-2xs text-destructive">{run.error}</p>
      )}
      {expanded ? (
        <div className="mt-1">
          <RunOutput run={run} />
        </div>
      ) : null}
    </li>
  );
}

function TaskRow({
  job,
  onSetEnabled,
  onSetMuted,
}: {
  readonly job: HermesCronJob;
  readonly onSetEnabled: (jobId: HermesCronJobId, enabled: boolean) => void;
  readonly onSetMuted: (jobId: HermesCronJobId, muted: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const pauseLabel = job.enabled ? "Pause task" : "Resume task";
  const muteLabel = job.muted ? "Unmute notifications" : "Mute notifications";

  return (
    <li className="rounded-lg border border-border/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRightIcon
            className={cn("size-4 shrink-0 text-muted-foreground", expanded && "rotate-90")}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{job.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {describeHermesJobSummary(job)}
            </span>
          </span>
        </button>
        <StatusChip job={job} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={pauseLabel}
                aria-pressed={!job.enabled}
                onClick={() => onSetEnabled(job.id, !job.enabled)}
                size="icon"
                variant="ghost"
              >
                {job.enabled ? <PauseIcon /> : <PlayIcon />}
              </Button>
            }
          />
          <TooltipPopup side="top">{pauseLabel}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={muteLabel}
                aria-pressed={job.muted}
                onClick={() => onSetMuted(job.id, !job.muted)}
                size="icon"
                variant="ghost"
              >
                {job.muted ? <BellOffIcon /> : <BellIcon />}
              </Button>
            }
          />
          <TooltipPopup side="top">{muteLabel}</TooltipPopup>
        </Tooltip>
      </div>

      {expanded ? (
        <div className="mt-2 pl-6">
          {job.deliver.length > 0 ? (
            <p className="text-xs text-muted-foreground">Delivers to {job.deliver.join(", ")}</p>
          ) : null}
          {job.lastError === null ? null : (
            <p className="mt-1 break-words font-mono text-2xs text-destructive">{job.lastError}</p>
          )}
          {job.runs.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No recorded runs yet.</p>
          ) : (
            <ul className="mt-1">
              {job.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** Shape-matched ghost, so the real list does not shift the layout when it lands. */
function TasksGhost() {
  return (
    <ul className="flex flex-col gap-2" aria-hidden>
      {[0, 1, 2].map((index) => (
        <li key={index} className="rounded-lg border border-border/60 px-3 py-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-1.5 h-4 w-64" />
        </li>
      ))}
    </ul>
  );
}

export function HermesTasksTab({ onNewTask }: HermesTasksTabProps) {
  const { jobs, isPending, error, emptyState, view, setEnabled, setMuted } = useHermesCron();

  return (
    <div className="flex flex-col gap-3">
      {error !== null ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Hermes tasks are unavailable</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : isPending ? (
        <TasksGhost />
      ) : emptyState !== null ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{emptyState.title}</EmptyTitle>
            <EmptyDescription>{emptyState.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {view.snapshot?.runHistoryAvailable === false ? (
            <p className="text-xs text-muted-foreground">
              Run history is unavailable, so only the latest outcome is shown.
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {jobs.map((job) => (
              <TaskRow key={job.id} job={job} onSetEnabled={setEnabled} onSetMuted={setMuted} />
            ))}
          </ul>
        </>
      )}

      <div className="border-t border-border/60 pt-3">
        <Button onClick={onNewTask} variant="ghost">
          <PlusIcon />
          New task…
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          Tasks are written by Hermes itself — describe the schedule you want in chat.
        </p>
      </div>
    </div>
  );
}
