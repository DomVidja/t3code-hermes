import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export class HermesProfileDelegationError extends Schema.TaggedError<HermesProfileDelegationError>()(
  "HermesProfileDelegationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const HermesProfileDelegationInput = Schema.Struct({
  targetInstanceId: ProviderInstanceId,
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
});
export type HermesProfileDelegationInput = typeof HermesProfileDelegationInput.Type;
export const HermesProfileDelegationResult = Schema.Struct({
  childId: Schema.String,
  targetInstanceId: ProviderInstanceId,
  stopReason: Schema.String,
  output: Schema.String,
  truncated: Schema.Boolean,
});
export type HermesProfileDelegationResult = typeof HermesProfileDelegationResult.Type;

export const HermesProfileDelegationTarget = Schema.Struct({
  targetInstanceId: ProviderInstanceId,
  displayName: Schema.String,
});
export type HermesProfileDelegationTarget = typeof HermesProfileDelegationTarget.Type;
