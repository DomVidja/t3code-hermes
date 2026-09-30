/**
 * Hermes patches contract.
 *
 * The fork carries a few patches against Hermes Agent itself (`infra/hermes`)
 * for behaviour T3 Code depends on. They are applied to the user's own git
 * checkout of Hermes, so an update can drop one or leave it no longer fitting
 * without anything saying so. The Patches tab shows where each one stands and
 * applies or removes it.
 *
 * Only patches the environment itself ships can be applied: clients name a
 * patch by id and never send patch content.
 *
 * @module hermesPatches
 */
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HermesPatchId = TrimmedNonEmptyString.pipe(Schema.brand("HermesPatchId"));
export type HermesPatchId = typeof HermesPatchId.Type;

/**
 * - `applied`: the checkout already contains the change.
 * - `notApplied`: the patch applies cleanly and can be applied now.
 * - `doesNotApply`: it applies in neither direction. The checkout is a Hermes
 *   version the patch was not made for (older or newer), or has conflicting
 *   local edits.
 */
export const HermesPatchState = Schema.Literals(["applied", "notApplied", "doesNotApply"]);
export type HermesPatchState = typeof HermesPatchState.Type;

export const HermesPatch = Schema.Struct({
  id: HermesPatchId,
  title: TrimmedNonEmptyString,
  /** What stops working without the patch, in the user's terms. */
  neededFor: TrimmedNonEmptyString,
  state: HermesPatchState,
});
export type HermesPatch = typeof HermesPatch.Type;

/**
 * Whether the environment could inspect a Hermes checkout at all.
 *
 * `notGitCheckout` covers pip, Nix, Docker and package installs: patches apply
 * to a git checkout, the same install shape `hermes update` can update.
 */
export const HermesPatchesAvailability = Schema.Literals([
  "ready",
  "providerDisabled",
  "hermesNotFound",
  "notGitCheckout",
]);
export type HermesPatchesAvailability = typeof HermesPatchesAvailability.Type;

export const HermesPatchesSnapshot = Schema.Struct({
  availability: HermesPatchesAvailability,
  /** The checkout the states describe; null unless `ready`. */
  checkoutPath: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * True when the checkout is on a detached HEAD. `hermes update` cannot move
   * one, so Hermes stays on that commit however often it is updated.
   */
  detachedHead: Schema.Boolean,
  patches: ForwardCompatibleArray(HermesPatch),
});
export type HermesPatchesSnapshot = typeof HermesPatchesSnapshot.Type;

export const HermesPatchListInput = Schema.Struct({});
export type HermesPatchListInput = typeof HermesPatchListInput.Type;

export const HermesPatchChangeInput = Schema.Struct({
  patchId: HermesPatchId,
});
export type HermesPatchChangeInput = typeof HermesPatchChangeInput.Type;

export class HermesPatchError extends Schema.TaggedError<HermesPatchError>()("HermesPatchError", {
  reason: Schema.Literals(["unavailable", "unknownPatch", "wrongState", "commandFailed"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Hermes patch request failed (${this.reason}): ${this.detail}`;
  }
}
