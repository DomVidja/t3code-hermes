import { describeHermesPatchFailure } from "@t3tools/client-runtime/state/hermes-patches";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HermesPatchId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

/**
 * The Patches tab's read of one environment's Hermes checkout. `change`
 * resolves to null on success, or the reason to show when it failed.
 */
export function useHermesPatches(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesPatches({ environmentId, input: {} }),
  );
  const applyCommand = useAtomCommand(serverEnvironment.hermesPatchApply, {
    reportFailure: false,
  });
  const revertCommand = useAtomCommand(serverEnvironment.hermesPatchRevert, {
    reportFailure: false,
  });
  const [changingPatchId, setChangingPatchId] = useState<HermesPatchId | null>(null);
  const refresh = query.refresh;

  const change = async (
    patchId: HermesPatchId,
    direction: "apply" | "remove",
  ): Promise<string | null> => {
    if (environmentId === null || changingPatchId !== null) return null;
    setChangingPatchId(patchId);
    try {
      const command = direction === "apply" ? applyCommand : revertCommand;
      const result = await command({ environmentId, input: { patchId } });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
      return describeHermesPatchFailure(
        squashAtomCommandFailure(result),
        "The Hermes checkout could not be changed.",
      );
    } finally {
      setChangingPatchId(null);
      // Success or not, the checkout is the source of truth: read it again.
      refresh();
    }
  };

  return {
    snapshot: query.data,
    isPending: query.isPending && query.data === null,
    error: query.data === null ? query.error : null,
    changingPatchId,
    refresh,
    change,
  };
}
