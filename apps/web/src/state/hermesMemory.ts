import type {
  EnvironmentId,
  HermesMemoryMutateInput,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

/** Native Hermes notes use the environment connection, never a client-local file path. */
export function useHermesMemory(
  environmentId: EnvironmentId | null,
  instanceId?: ProviderInstanceId,
) {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.hermesMemory({
          environmentId,
          input: instanceId === undefined ? {} : { instanceId },
        }),
  );
  const command = useAtomCommand(serverEnvironment.hermesMemoryMutate, { reportFailure: false });
  const refresh = query.refresh;

  // The caller supplies the revision captured when its editor opened, not the
  // latest subscription revision: a live update must not authorize overwriting it.
  const mutate = useCallback(
    async (input: HermesMemoryMutateInput): Promise<string | null> => {
      if (environmentId === null) return "Enable Hermes in this environment to edit memory.";
      const result = await command({
        environmentId,
        input: { ...input, ...(instanceId === undefined ? {} : { instanceId }) },
      });
      if (result._tag !== "Success") {
        if (isAtomCommandInterrupted(result)) {
          return "The request was interrupted. Your draft has been kept.";
        }
        refresh();
        return formatEnvironmentQueryError(result.cause);
      }
      refresh();
      return null;
    },
    [command, environmentId, instanceId, refresh],
  );

  return { ...query, mutate };
}
