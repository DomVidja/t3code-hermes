import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  HermesMemoryMutateInput,
  HermesMemoryTarget,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useRef, useState } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export function useHermesMemory(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(serverEnvironment.hermesMemory({ environmentId, input: {} }));
  const command = useAtomCommand(serverEnvironment.hermesMemoryMutate, { reportFailure: false });
  const [pendingTarget, setPendingTarget] = useState<HermesMemoryTarget | null>(null);
  const pending = useRef(false);
  const { refresh } = query;

  // Return the server error to the editor, which owns its draft and captured revision.
  const mutate = useCallback(
    async (input: HermesMemoryMutateInput): Promise<string | null> => {
      if (pending.current) return "Wait for the current memory change to finish.";
      pending.current = true;
      setPendingTarget(input.target);
      try {
        const result = await command({ environmentId, input });
        refresh();
        if (result._tag === "Success") return null;
        if (isAtomCommandInterrupted(result)) {
          return "The request was interrupted. Your draft has been kept.";
        }
        const error = Cause.squash(result.cause);
        return error instanceof Error
          ? error.message
          : "The environment could not save this change.";
      } catch (error) {
        return error instanceof Error
          ? error.message
          : "The environment could not save this change.";
      } finally {
        pending.current = false;
        setPendingTarget(null);
      }
    },
    [command, environmentId, refresh],
  );

  return {
    snapshot: query.data,
    error: query.error,
    pendingTarget,
    retry: refresh,
    mutate,
  };
}
