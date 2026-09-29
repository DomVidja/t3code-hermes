/**
 * Turns finished Hermes runs into a toast and a sidebar dot.
 *
 * Mounted from the sidebar footer rather than the panel, because a dot that
 * only lights while you are already looking at the panel would be pointless.
 * That does mean a client with Hermes holds one cron subscription for as long
 * as it is connected — which is the same thing "at least one client is
 * subscribed" means to the environment, and costs one small frame per change.
 */
import type { HermesCronView } from "@t3tools/client-runtime/state/hermes-cron";
import { useEffect, useRef } from "react";

import { useHermesCron } from "../../state/hermesCron";
import { reportHermesCompletion } from "../../state/hermesCronSeen";
import { toastManager } from "../ui/toast";

export function useHermesCronNotifications(): void {
  const { view, environmentId } = useHermesCron();
  // Each finished run arrives as a new object that snapshot folds carry along
  // unchanged, so identity marks "already toasted". `completionSeq` would not:
  // it restarts on every reconnect and differs per environment.
  const lastToasted = useRef<HermesCronView["lastCompletion"]>(null);

  useEffect(() => {
    const { lastCompletion } = view;
    if (environmentId === null || lastCompletion === null) return;
    if (lastCompletion === lastToasted.current) return;
    lastToasted.current = lastCompletion;

    reportHermesCompletion(environmentId);
    toastManager.add(
      lastCompletion.status === "failed"
        ? {
            type: "error",
            title: `Task failed: ${lastCompletion.jobName}`,
            description: lastCompletion.error ?? "Hermes did not record a reason.",
          }
        : {
            type: "success",
            title: `Task finished: ${lastCompletion.jobName}`,
            description: "Scheduled run completed.",
          },
    );
  }, [environmentId, view]);
}
