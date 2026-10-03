import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Each provider owns its snapshot, subscriptions and watcher lifetime. */
export const makeHermesInstanceServices = <A, E, R>(
  factory: (instanceId?: ProviderInstanceId) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const lock = yield* Semaphore.make(1);
    const instances = new Map<string, Effect.Effect<A, E>>();
    return (instanceId?: ProviderInstanceId): Effect.Effect<A, E> =>
      Effect.flatMap(
        lock.withPermits(1)(
          Effect.gen(function* () {
            const key = instanceId ?? "";
            const existing = instances.get(key);
            if (existing !== undefined) return existing;
            const cached = yield* Effect.cached(
              factory(instanceId).pipe(Effect.provideContext(context)),
            );
            instances.set(key, cached);
            return cached;
          }),
        ),
        (cached) => cached,
      );
  });
