/**
 * Client-side view of the Hermes cron subscription.
 *
 * The environment streams two kinds of event — a snapshot when the task list
 * changed, and a one-off announcement when a run finished. A React panel wants
 * neither of those directly; it wants "the current tasks, plus whether
 * something just landed". This module folds the stream into exactly that, so
 * both web and mobile can render from one shape and no client has to remember
 * which event it saw last.
 *
 * @module state/hermesCron
 */
import type {
  HermesCronJob,
  HermesCronRunCompleted,
  HermesCronSnapshot,
  HermesCronStreamEvent,
} from "@t3tools/contracts";
import { DateTime, Option } from "effect";

export interface HermesCronView {
  readonly snapshot: HermesCronSnapshot | null;
  /**
   * The most recent finished run, or `null` if none has landed this session.
   *
   * Paired with {@link completionSeq} rather than replaced-and-forgotten so a
   * consumer can tell "the same run I already toasted" from "it happened
   * again" without diffing run ids itself.
   */
  readonly lastCompletion: HermesCronRunCompleted | null;
  /** Increments once per completed run. Never resets while subscribed. */
  readonly completionSeq: number;
}

export const emptyHermesCronView: HermesCronView = {
  snapshot: null,
  lastCompletion: null,
  completionSeq: 0,
};

/**
 * Folds one event into the view.
 *
 * A `runCompleted` event deliberately keeps the previous snapshot: the
 * environment sends the announcement and the refreshed snapshot separately,
 * and blanking the list in between would flash the panel empty.
 */
function foldHermesCronEvent(
  previous: HermesCronView,
  event: HermesCronStreamEvent,
): HermesCronView {
  if (event._tag === "snapshot") {
    return { ...previous, snapshot: event.snapshot };
  }
  return {
    snapshot: previous.snapshot,
    lastCompletion: event.run,
    completionSeq: previous.completionSeq + 1,
  };
}

/**
 * `Stream.mapAccum` shape of {@link foldHermesCronEvent}: every event yields
 * the freshly folded view, so subscribers always hold the whole picture.
 */
export function foldHermesCronView(
  current: HermesCronView,
  event: HermesCronStreamEvent,
): readonly [HermesCronView, ReadonlyArray<HermesCronView>] {
  const next = foldHermesCronEvent(current, event);
  return [next, [next]];
}

/**
 * Seeds a composer so the user writes the schedule, not a form.
 *
 * Shared because the sentence a client starts for you is part of the feature,
 * not of the platform: web drops it into the chat composer, mobile copies it
 * for the existing new-task flow, and both must start the same way.
 */
export const HERMES_NEW_TASK_TEMPLATE = "Schedule a recurring task: ";

/** `null` when Hermes has never recorded a finished run for the job. */
export function formatHermesRunDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds % 60}s`;
}

/** `null` for both "never happened" and "Hermes wrote something unparseable". */
export function formatHermesTimestamp(value: string | null): string | null {
  if (value === null) return null;
  return Option.getOrNull(
    DateTime.make(value).pipe(Option.map((parsed) => DateTime.toDate(parsed).toLocaleString())),
  );
}

export type HermesCronStatusTone = "ok" | "failed" | "paused" | "idle";

export interface HermesCronStatusChip {
  readonly tone: HermesCronStatusTone;
  readonly label: string;
}

/**
 * The chip a job row shows.
 *
 * The job's own state outranks its history: a paused job that failed last week
 * is paused, not failed. Only once the state says the job is live does the
 * latest run get to speak.
 */
export function describeHermesJobStatus(job: HermesCronJob): HermesCronStatusChip {
  if (job.state === "paused") return { tone: "paused", label: "Paused" };
  if (job.state === "error") return { tone: "failed", label: "Error" };
  if (job.state === "completed") return { tone: "idle", label: "Completed" };
  const lastRun = job.runs[0];
  if (lastRun?.status === "failed" || job.lastStatus === "failed") {
    return { tone: "failed", label: "Failed" };
  }
  if (job.lastStatus === "ok" || lastRun?.status === "completed") {
    return { tone: "ok", label: "OK" };
  }
  return { tone: "idle", label: "Scheduled" };
}

/** One line under a job's name: schedule, last run, and how long it took. */
export function describeHermesJobSummary(job: HermesCronJob): string {
  const parts: string[] = [job.scheduleDisplay];
  const lastRun = formatHermesTimestamp(job.lastRunAt);
  parts.push(lastRun === null ? "never run" : `last run ${lastRun}`);
  const duration = formatHermesRunDuration(job.runs[0]?.durationMs ?? null);
  if (duration !== null) parts.push(duration);
  return parts.join(" · ");
}

/** Why the task list is empty, in words a panel can render as-is. */
export interface HermesCronEmptyState {
  readonly title: string;
  readonly description: string;
}

/**
 * Copy for every non-populated state.
 *
 * Returns `null` when there are tasks to show. The distinction between "not
 * enabled", "never used", and "could not read" is kept all the way to the UI
 * because each one has a different next action for the reader.
 */
export function describeHermesCronEmptyState(
  snapshot: HermesCronSnapshot | null,
): HermesCronEmptyState | null {
  if (snapshot === null) return null;
  if (snapshot.jobs.length > 0) return null;

  switch (snapshot.availability) {
    case "providerDisabled":
      return {
        title: "Hermes is not enabled here",
        description: "Turn on the Hermes provider in Settings to see its scheduled tasks.",
      };
    case "unreadable":
      return {
        title: "Hermes tasks could not be read",
        description: snapshot.detail ?? "The scheduled task list could not be read.",
      };
    case "noCronStore":
    case "ready":
      return {
        title: "No scheduled tasks",
        description:
          'Tasks are created by asking Hermes in chat — try "every morning at 9, summarise my open PRs".',
      };
  }
}

/** Header fields a run row already shows, so the document body drops them. */
const REDUNDANT_RUN_FIELDS = new Set(["Job ID", "Run Time", "Schedule"]);
const RUN_FIELD_LINE = /^\*\*([^*]+):\*\*\s/;
/** Hermes's reply for a run with nothing new to say; it suppresses delivery. */
const SILENT_RESPONSE = "[SILENT]";

/**
 * The part of a Hermes run document worth reading under a run row.
 *
 * Hermes saves each run as `# Cron Job: <name>`, a block of `**Field:**`
 * lines, then `## Prompt`, and finally `## Response` or, for a failed agent
 * run, `## Error`. The row already shows the name and time, and the prompt is
 * the job's own instructions plus a long scheduler preamble, identical on every
 * run. What is left is the result: the response, the error, or the status note
 * Hermes wrote for a script, silent, or blocked run.
 *
 * The prompt can itself contain whole earlier run documents — a job that reads
 * its previous output gets it pasted in, headings and all — so the result is
 * the *last* `## Response` or `## Error`, never the first heading after the
 * prompt.
 */
export function describeHermesRunDocument(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  if (lines[0]?.startsWith("# Cron Job:")) index = 1;

  const fields: string[] = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    const field = RUN_FIELD_LINE.exec(line);
    if (field === null) break;
    if (!REDUNDANT_RUN_FIELDS.has(field[1]!)) fields.push(line);
  }

  let body = lines.slice(index);
  if (body[0] === "## Prompt") {
    const result = body.findLastIndex((line) => line === "## Response" || line === "## Error");
    if (result <= 0) body = [];
    // The response heading is the only one left, so it says nothing; an error
    // heading is the one signal that the run failed.
    else body = body.slice(body[result] === "## Response" ? result + 1 : result);
  }

  let result = body.join("\n").trim();
  if (result === SILENT_RESPONSE) result = "_Nothing new to report, so nothing was delivered._";

  // Hermes separates the fields with single newlines, which markdown would run
  // together into one paragraph.
  return [fields.join("  \n"), result].filter((part) => part.length > 0).join("\n\n");
}
