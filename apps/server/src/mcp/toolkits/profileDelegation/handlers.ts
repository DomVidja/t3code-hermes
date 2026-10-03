import * as Schema from "effect/Schema";
import { HermesProfileDelegationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Delegation from "../../../hermes/HermesProfileDelegationService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { ProfileDelegationToolkit } from "./tools.ts";

const isDelegationError = Schema.is(HermesProfileDelegationError);

export const ProfileDelegationToolkitHandlersLive = ProfileDelegationToolkit.toLayer({
  list_profile_delegation_targets: (input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.requireMcpCapability("profile-delegation");
      const service = yield* Delegation.HermesProfileDelegationService;
      return yield* service.listTargets(scope, input.targetInstanceId);
    }).pipe(
      Effect.mapError((cause) =>
        isDelegationError(cause)
          ? cause
          : new HermesProfileDelegationError({ detail: cause.message }),
      ),
    ),
  delegate_to_profile: (input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.requireMcpCapability("profile-delegation");
      const service = yield* Delegation.HermesProfileDelegationService;
      return yield* service.delegate(scope, input);
    }).pipe(
      Effect.mapError((cause) =>
        isDelegationError(cause)
          ? cause
          : new HermesProfileDelegationError({ detail: cause.message }),
      ),
    ),
});
