/**
 * Hermes runs contract: which of Hermes's background jobs mirror into threads.
 *
 * Hermes does work on its own — webhook routes fire on incoming events and
 * cron jobs fire on a schedule — in any of its profiles. The environment
 * discovers those sources from Hermes's own config and session store, and the
 * user switches on the ones whose runs should appear as threads in a project.
 * Everything else about a run (its transcript, PR, and lifecycle) arrives
 * through the ordinary thread read model.
 *
 * @module hermesRuns
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import type { ThreadHermesRun } from "./orchestration.ts";

export const HermesRunSourceKind = Schema.Literals(["webhook", "cron"]);
export type HermesRunSourceKind = typeof HermesRunSourceKind.Type;

export const HermesRunSource = Schema.Struct({
  /** "default", or a profile name under `<hermes home>/profiles/`. */
  profile: TrimmedNonEmptyString,
  /** "webhook:<route>" or "cron:<jobId>". Stable across renames of a cron job. */
  sourceKey: TrimmedNonEmptyString,
  kind: HermesRunSourceKind,
  /** Route name or job name. */
  label: TrimmedNonEmptyString,
  /** Events a route listens for, or a job's schedule. */
  detail: Schema.NullOr(Schema.String),
  /** False when the route or job is gone from Hermes's config but has past runs. */
  configured: Schema.Boolean,
  lastRunAt: Schema.NullOr(IsoDateTime),
  /** Runs in the last 30 days that used tools, the ones that would become threads. */
  recentRunCount: NonNegativeInt,
  /** Project its runs become threads in; null while switched off. */
  projectId: Schema.NullOr(ProjectId),
  /** Best guess at the project, from a cron job's workdir or a repository the route names. */
  suggestedProjectId: Schema.NullOr(ProjectId),
});
export type HermesRunSource = typeof HermesRunSource.Type;

export const HermesRunSourcesResult = Schema.Struct({
  /** False when no Hermes provider is enabled; `sources` is then empty. */
  hermesEnabled: Schema.Boolean,
  sources: ForwardCompatibleArray(HermesRunSource),
});
export type HermesRunSourcesResult = typeof HermesRunSourcesResult.Type;

export const HermesRunSourcesListInput = Schema.Struct({});
export type HermesRunSourcesListInput = typeof HermesRunSourcesListInput.Type;

/** Switch a source on (with the project its runs go to) or off (null). */
export const HermesRunSourceSetInput = Schema.Struct({
  profile: TrimmedNonEmptyString,
  sourceKey: TrimmedNonEmptyString,
  projectId: Schema.NullOr(ProjectId),
});
export type HermesRunSourceSetInput = typeof HermesRunSourceSetInput.Type;

export class HermesRunError extends Schema.TaggedError<HermesRunError>()("HermesRunError", {
  reason: Schema.Literals(["providerDisabled", "unknownProject", "unreadable", "writeFailed"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Hermes runs request failed (${this.reason}): ${this.detail}`;
  }
}

/**
 * Whether a reply to `run`'s thread has to wait. A source's runs share state
 * (the resolver's branch, a job's working files), so replying to any of its
 * threads waits until none of its runs is still live.
 */
export function isHermesRunSourceBusy(
  run: ThreadHermesRun,
  threads: ReadonlyArray<{
    readonly hermesRun?: ThreadHermesRun | null | undefined;
    readonly deletedAt?: string | null;
  }>,
): boolean {
  return threads.some(
    (thread) =>
      (thread.deletedAt ?? null) === null &&
      thread.hermesRun?.live === true &&
      thread.hermesRun.profile === run.profile &&
      thread.hermesRun.sourceKey === run.sourceKey,
  );
}
