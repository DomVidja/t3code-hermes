import { EnvironmentId, HermesCronJobId } from "@t3tools/contracts";

export interface HermesSearch {
  readonly environmentId?: EnvironmentId;
  readonly jobId?: HermesCronJobId;
  readonly runId?: string;
}

export const EMPTY_HERMES_SEARCH: HermesSearch = {};

/** A task/run deep link is meaningful only with its owning environment. */
export function validateHermesSearch(raw: Record<string, unknown>): HermesSearch {
  const environmentId = typeof raw.environmentId === "string" ? raw.environmentId.trim() : "";
  if (!environmentId) return {};
  const jobId = typeof raw.jobId === "string" ? raw.jobId.trim() : "";
  const runId = typeof raw.runId === "string" ? raw.runId.trim() : "";
  return {
    environmentId: EnvironmentId.make(environmentId),
    ...(jobId ? { jobId: HermesCronJobId.make(jobId), ...(runId ? { runId } : {}) } : {}),
  };
}
