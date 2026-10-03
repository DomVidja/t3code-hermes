import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

export const HermesPanelScope = createContext<{
  readonly environmentId: EnvironmentId | null;
  readonly instanceId?: ProviderInstanceId | undefined;
} | null>(null);

export const useHermesPanelScope = () => useContext(HermesPanelScope);
