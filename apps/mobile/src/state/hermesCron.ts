import {
  describeHermesCronEmptyState,
  describeHermesRunDocument,
  emptyHermesCronView,
  type HermesCronView,
} from "@t3tools/client-runtime/state/hermes-cron";
import type { EnvironmentId, HermesCronJobId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export interface HermesCronState {
  readonly view: HermesCronView;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly emptyState: ReturnType<typeof describeHermesCronEmptyState>;
}

export function useHermesCron(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesCron({ environmentId, input: {} }),
  );
  const view = query.data ?? emptyHermesCronView;
  const [pendingJobIds, setPendingJobIds] = useState<ReadonlySet<HermesCronJobId>>(() => new Set());
  const setEnabledCommand = useAtomCommand(serverEnvironment.hermesCronSetEnabled, {
    reportFailure: false,
  });
  const setMutedCommand = useAtomCommand(serverEnvironment.hermesCronSetMuted, {
    reportFailure: false,
  });

  const runMutation = useCallback(
    async (
      jobId: HermesCronJobId,
      mutation: () => Promise<{ readonly _tag: string }>,
    ): Promise<boolean> => {
      setPendingJobIds((current) => new Set(current).add(jobId));
      try {
        const result = await mutation();
        return result._tag === "Success";
      } finally {
        setPendingJobIds((current) => {
          const next = new Set(current);
          next.delete(jobId);
          return next;
        });
      }
    },
    [],
  );

  const setEnabled = useCallback(
    (jobId: HermesCronJobId, enabled: boolean) => {
      if (environmentId === null) return Promise.resolve(false);
      return runMutation(jobId, () =>
        setEnabledCommand({ environmentId, input: { jobId, enabled } }),
      );
    },
    [environmentId, runMutation, setEnabledCommand],
  );

  const setMuted = useCallback(
    (jobId: HermesCronJobId, muted: boolean) => {
      if (environmentId === null) return Promise.resolve(false);
      return runMutation(jobId, () => setMutedCommand({ environmentId, input: { jobId, muted } }));
    },
    [environmentId, runMutation, setMutedCommand],
  );

  const jobs = useMemo(() => view.snapshot?.jobs ?? [], [view.snapshot]);

  return {
    view,
    jobs,
    pendingJobIds,
    isPending: query.isPending && view.snapshot === null,
    error: view.snapshot === null ? query.error : null,
    emptyState: describeHermesCronEmptyState(view.snapshot),
    refresh: query.refresh,
    setEnabled,
    setMuted,
  };
}

/** The document Hermes saved for one finished run, fetched when the row opens. */
export function useHermesRunOutput(
  environmentId: EnvironmentId,
  jobId: HermesCronJobId,
  runId: string,
) {
  const query = useEnvironmentQuery(
    serverEnvironment.hermesCronRunOutput({ environmentId, input: { jobId, runId } }),
  );
  const markdown = query.data?.markdown ?? null;
  const document = useMemo(
    () => (markdown === null ? null : describeHermesRunDocument(markdown)),
    [markdown],
  );
  return {
    /** The readable part of the saved document; `null` when Hermes kept none. */
    document,
    truncated: query.data?.truncated ?? false,
    isPending: query.isPending && query.data === null,
    error: query.data === null ? query.error : null,
  };
}
