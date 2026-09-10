import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { StackStatus, StackViewFailedError, StackViewInput } from "@t3tools/contracts";

import * as GhStackCli from "./GhStackCli.ts";

/**
 * An environment with no `gh` answers "unavailable" instantly and forever;
 * without a TTL every sidebar scroll would spawn a process to learn that
 * again. Short enough that installing `gh` shows up without a restart.
 */
export const STACK_UNAVAILABLE_TTL = Duration.seconds(30);

interface CachedStack {
  readonly fingerprint: string;
  readonly status: StackStatus;
  /** Epoch millis, or null for an entry that only signals invalidate it. */
  readonly expiresAtMillis: number | null;
}

interface StackChange {
  readonly worktreePath: string;
  readonly status: StackStatus;
}

export class StackViewBroadcaster extends Context.Service<
  StackViewBroadcaster,
  {
    readonly getStack: (worktreePath: string) => Effect.Effect<StackStatus, StackViewFailedError>;
    readonly refreshStack: (
      worktreePath: string,
    ) => Effect.Effect<StackStatus, StackViewFailedError>;
    readonly invalidate: (worktreePath: string) => Effect.Effect<void>;
    readonly streamStack: (
      input: StackViewInput,
    ) => Stream.Stream<StackStatus, StackViewFailedError>;
    /** One permit per cwd, shared by reads and actions: a `gh stack sync` must
        not interleave with the read that publishes the new chain. */
    readonly withStackPermit: <A, E, R>(
      worktreePath: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/stack/StackViewBroadcaster") {}

function fingerprintStatus(status: StackStatus): string {
  return JSON.stringify(status);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const cli = yield* GhStackCli.GhStackCli;
  const cacheRef = yield* Ref.make(new Map<string, CachedStack>());
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<StackChange>(), (pubsub) =>
    PubSub.shutdown(pubsub),
  );

  // Reads and actions for one worktree share a permit: a chain published from
  // a read that started before `gh stack sync` must not land after it.
  const permits = new Map<string, Semaphore.Semaphore>();
  const withStackPermit = <A, E, R>(worktreePath: string, effect: Effect.Effect<A, E, R>) => {
    let permit = permits.get(worktreePath);
    if (permit === undefined) {
      permit = Semaphore.makeUnsafe(1);
      permits.set(worktreePath, permit);
    }
    return permit.withPermits(1)(effect);
  };

  const readStack = Effect.fn("StackViewBroadcaster.readStack")(function* (worktreePath: string) {
    const observedAt = yield* DateTime.now;
    const outcome = yield* cli.view({ cwd: worktreePath });
    if (outcome._tag === "unavailable") {
      const expiresAt = DateTime.addDuration(observedAt, STACK_UNAVAILABLE_TTL);
      return {
        status: {
          _tag: "unavailable",
          reason: outcome.reason,
          freshness: { source: "live-local", observedAt, expiresAt: Option.some(expiresAt) },
        },
        expiresAtMillis: DateTime.toEpochMillis(expiresAt),
      } as const;
    }
    return {
      status: {
        _tag: "available",
        worktreePath,
        trunk: outcome.raw.trunk,
        // `PositiveInt`/`NonNegativeInt` are unbranded `Schema.Int.check(...)`,
        // so their Type is plain `number` — assign the number, no constructor.
        stackNumber:
          outcome.raw.stackNumber !== null && outcome.raw.stackNumber > 0
            ? outcome.raw.stackNumber
            : null,
        layers: outcome.raw.branches.map((branch, index) => ({
          branch: branch.name,
          position: index,
        })),
        freshness: { source: "live-local", observedAt, expiresAt: Option.none() },
      },
      expiresAtMillis: null,
    } as const;
  });

  /**
   * Write the cache silently — used to populate a cold cache from a plain
   * read. A read is not one of the four invalidation signals, so it must not
   * echo back onto the PubSub (a `streamStack` subscriber that races its own
   * cold-cache read against the subscription it just opened would otherwise
   * see its own read as a phantom "change").
   */
  const writeCacheSilently = Effect.fn("StackViewBroadcaster.writeCacheSilently")(function* (
    worktreePath: string,
    read: { readonly status: StackStatus; readonly expiresAtMillis: number | null },
  ) {
    yield* Ref.update(cacheRef, (cache) => {
      const next = new Map(cache);
      next.set(worktreePath, {
        fingerprint: fingerprintStatus(read.status),
        status: read.status,
        expiresAtMillis: read.expiresAtMillis,
      });
      return next;
    });
    return read.status;
  });

  /** Write the cache and publish only on a fingerprint change. */
  const publishIfChanged = Effect.fn("StackViewBroadcaster.publishIfChanged")(function* (
    worktreePath: string,
    read: { readonly status: StackStatus; readonly expiresAtMillis: number | null },
  ) {
    const fingerprint = fingerprintStatus(read.status);
    const changed = yield* Ref.modify(cacheRef, (cache) => {
      const previous = cache.get(worktreePath);
      const next = new Map(cache);
      next.set(worktreePath, {
        fingerprint,
        status: read.status,
        expiresAtMillis: read.expiresAtMillis,
      });
      return [previous?.fingerprint !== fingerprint, next] as const;
    });
    if (changed) {
      yield* PubSub.publish(changes, { worktreePath, status: read.status });
    }
    return read.status;
  });

  const refreshStack: StackViewBroadcaster["Service"]["refreshStack"] = (worktreePath) =>
    withStackPermit(
      worktreePath,
      readStack(worktreePath).pipe(Effect.flatMap((read) => publishIfChanged(worktreePath, read))),
    );

  const getStack: StackViewBroadcaster["Service"]["getStack"] = (worktreePath) =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(cacheRef).pipe(
        Effect.map((cache) => cache.get(worktreePath) ?? null),
      );
      if (cached !== null) {
        const nowMillis = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
        if (cached.expiresAtMillis === null || cached.expiresAtMillis > nowMillis) {
          return cached.status;
        }
      }
      return yield* withStackPermit(
        worktreePath,
        readStack(worktreePath).pipe(
          Effect.flatMap((read) => writeCacheSilently(worktreePath, read)),
        ),
      );
    });

  const invalidate: StackViewBroadcaster["Service"]["invalidate"] = (worktreePath) =>
    Ref.update(cacheRef, (cache) => {
      const next = new Map(cache);
      next.delete(worktreePath);
      return next;
    });

  /**
   * No poller. The cache is invalidated by four signals: a client subscribing
   * with a cold cache, a turn finishing in the worktree, a `stack.action` run
   * through T3, and a HEAD change seen by the cwd's VCS status.
   *
   * Known hole: `gh stack add` typed straight into a terminal fires none of
   * them. The mitigations are the refresh button on the stack row and the
   * invalidation on terminal-tab close. A `.git/` watcher was rejected: it
   * would depend on a gh-stack metadata layout the extension does not promise.
   */
  const streamStack: StackViewBroadcaster["Service"]["streamStack"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        // Signal 1: a client subscribing to a stack row with a cold cache.
        const initial = yield* getStack(input.worktreePath);
        return Stream.concat(
          Stream.make(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.worktreePath === input.worktreePath),
            Stream.map((change) => change.status),
          ),
        );
      }),
    );

  return StackViewBroadcaster.of({
    getStack,
    refreshStack,
    invalidate,
    streamStack,
    withStackPermit,
  });
});

export const layer = Layer.effect(StackViewBroadcaster, make);
