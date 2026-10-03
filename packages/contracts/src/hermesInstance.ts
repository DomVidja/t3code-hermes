import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/** Omission selects the environment default; an explicit id never falls back. */
export const HermesInstanceScope = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type HermesInstanceScope = typeof HermesInstanceScope.Type;
