import type { ProviderInstanceId, RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as AcpSchema from "effect-acp/schema";
import type * as AcpErrors from "effect-acp/errors";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

export class ProfileDelegationAuthorityError extends Schema.TaggedError<ProfileDelegationAuthorityError>()(
  "ProfileDelegationAuthorityError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface ParentLease {
  readonly owner: Pick<
    McpInvocationScope,
    "environmentId" | "threadId" | "providerSessionId" | "providerInstanceId"
  >;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly allowedTargets: ReadonlySet<ProviderInstanceId>;
  readonly requestPermission: (
    childId: string,
    target: ProviderInstanceId,
    params: AcpSchema.RequestPermissionRequest,
  ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpErrors.AcpError>;
}

export interface ActiveParentLease extends ParentLease {
  readonly closed: Deferred.Deferred<void>;
  readonly cancelled: Deferred.Deferred<void>;
}

export class HermesParentSessionAuthority extends Context.Service<
  HermesParentSessionAuthority,
  {
    readonly register: (
      lease: ParentLease,
    ) => Effect.Effect<void, ProfileDelegationAuthorityError, Scope.Scope>;
    readonly revoke: (providerSessionId: string) => Effect.Effect<void>;
    readonly cancelChildren: (providerSessionId: string) => Effect.Effect<void>;
    readonly resolve: (
      scope: McpInvocationScope,
      target?: ProviderInstanceId,
    ) => Effect.Effect<ActiveParentLease, ProfileDelegationAuthorityError>;
  }
>()("t3-hermes/hermes/HermesParentSessionAuthority") {}

const make = Effect.sync(() => {
  const leases = new Map<string, ActiveParentLease>();
  const register = Effect.fn("HermesParentSessionAuthority.register")(function* (
    lease: ParentLease,
  ) {
    if (leases.has(lease.owner.providerSessionId))
      return yield* new ProfileDelegationAuthorityError({
        reason: "A parent lease already exists for this session.",
      });
    const active = {
      ...lease,
      closed: yield* Deferred.make<void>(),
      cancelled: yield* Deferred.make<void>(),
    };
    leases.set(lease.owner.providerSessionId, active);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (leases.get(lease.owner.providerSessionId)?.closed === active.closed)
          leases.delete(lease.owner.providerSessionId);
        yield* Deferred.succeed(active.closed, undefined);
      }),
    );
  });
  const resolve = Effect.fn("HermesParentSessionAuthority.resolve")(function* (
    scope: McpInvocationScope,
    target?: ProviderInstanceId,
  ) {
    const lease = leases.get(scope.providerSessionId);
    if (
      !scope.capabilities.has("profile-delegation") ||
      !lease ||
      lease.owner.environmentId !== scope.environmentId ||
      lease.owner.threadId !== scope.threadId ||
      lease.owner.providerInstanceId !== scope.providerInstanceId ||
      (target !== undefined && !lease.allowedTargets.has(target)) ||
      target === scope.providerInstanceId
    ) {
      return yield* new ProfileDelegationAuthorityError({
        reason: "This live parent session does not authorize delegation to that profile.",
      });
    }
    return lease;
  });
  const cancelChildren = Effect.fn("HermesParentSessionAuthority.cancelChildren")(function* (
    providerSessionId: string,
  ) {
    const lease = leases.get(providerSessionId);
    if (!lease) return;
    leases.set(providerSessionId, { ...lease, cancelled: yield* Deferred.make<void>() });
    yield* Deferred.succeed(lease.cancelled, undefined);
  });
  const revoke = Effect.fn("HermesParentSessionAuthority.revoke")(function* (
    providerSessionId: string,
  ) {
    const lease = leases.get(providerSessionId);
    if (!lease) return;
    leases.delete(providerSessionId);
    yield* Deferred.succeed(lease.closed, undefined);
  });
  return HermesParentSessionAuthority.of({ register, resolve, cancelChildren, revoke });
});
export const layer = Layer.effect(HermesParentSessionAuthority, make);
