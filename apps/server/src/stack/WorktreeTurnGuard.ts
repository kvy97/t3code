import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  StackViewFailedError,
  StackWorktreeBusyError,
  StackWorktreeDirtyError,
  type ThreadId,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GhStackCli from "./GhStackCli.ts";
import { findBusyWorktreeThread, type WorktreeThreadFact } from "./StackActionRunner.ts";
import * as StackViewBroadcaster from "./StackViewBroadcaster.ts";

export type WorktreeTurnDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "busy"; readonly blockingThreadId: ThreadId; readonly branch: string | null }
  | { readonly kind: "dirty"; readonly headBranch: string; readonly changedFileCount: number }
  | { readonly kind: "checkout"; readonly branch: string };

/**
 * Worktree-wide on purpose, not stack-only: two threads sharing a worktree
 * have always been able to fight over the checkout, and this is the fix at the
 * root rather than at the stack.
 *
 * Order matters. Busy first, because interrupting the other turn is the one
 * action the user must take. Then a dirty mismatch, which is refused outright:
 * moving uncommitted work between branches is data loss dressed as a
 * convenience, so there is no implicit stash, ever.
 */
export function decideWorktreeTurn(input: {
  readonly threadId: ThreadId;
  readonly threadBranch: string | null;
  readonly worktreePath: string | null;
  readonly threads: ReadonlyArray<WorktreeThreadFact>;
  readonly headBranch: string | null;
  readonly changedFileCount: number;
}): WorktreeTurnDecision {
  if (input.worktreePath === null) return { kind: "proceed" };

  const busy = findBusyWorktreeThread({
    worktreePath: input.worktreePath,
    threads: input.threads,
    excludeThreadId: input.threadId,
  });
  if (busy !== null) {
    return { kind: "busy", blockingThreadId: busy.id, branch: busy.branch };
  }

  if (input.threadBranch === null) return { kind: "proceed" };
  if (input.headBranch === null || input.headBranch === input.threadBranch) {
    return { kind: "proceed" };
  }
  if (input.changedFileCount > 0) {
    return {
      kind: "dirty",
      headBranch: input.headBranch,
      changedFileCount: input.changedFileCount,
    };
  }
  return { kind: "checkout", branch: input.threadBranch };
}

export class WorktreeTurnGuard extends Context.Service<
  WorktreeTurnGuard,
  {
    readonly ensureReady: (
      threadId: ThreadId,
    ) => Effect.Effect<
      void,
      StackWorktreeBusyError | StackWorktreeDirtyError | StackViewFailedError
    >;
  }
>()("t3/stack/WorktreeTurnGuard") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const stacks = yield* StackViewBroadcaster.StackViewBroadcaster;
  const cli = yield* GhStackCli.GhStackCli;

  const ensureReady: WorktreeTurnGuard["Service"]["ensureReady"] = (threadId) =>
    Effect.gen(function* () {
      // A failed projection read must not silently become a green light: the
      // guard would wave through a turn it never actually checked. Only a
      // genuinely absent thread (a bootstrap turn, which creates its thread
      // inside dispatchBootstrapTurnStart) means "nothing to guard yet".
      const thread = yield* snapshots.getThreadShellById(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new StackViewFailedError({
              // The worktree is unknown here by construction: the thread read
              // that would have told us is the thing that failed.
              worktreePath: "",
              detail: `Could not read thread ${threadId} before its turn: ${cause.message}`,
            }),
        ),
      );
      if (Option.isNone(thread)) return;
      const worktreePath = thread.value.worktreePath;
      if (worktreePath === null) return;

      const threads = yield* snapshots.getShellSnapshot().pipe(
        Effect.map((snapshot) =>
          snapshot.threads.map((shell): WorktreeThreadFact => ({
            id: shell.id,
            branch: shell.branch,
            worktreePath: shell.worktreePath,
            latestTurnState: shell.latestTurn?.state ?? null,
          })),
        ),
        // A projection read failure must not turn into a silent green light:
        // an empty list here would let a second turn start on a busy worktree.
        Effect.mapError(
          (cause) =>
            new StackViewFailedError({
              worktreePath,
              detail: `Could not read the worktree's threads: ${cause.message}`,
            }),
        ),
      );

      // The cached VCS status is the single source for HEAD and dirtiness.
      // Local half only: this runs before the user's turn starts, and the
      // full `getStatus` ends in a cached `git fetch` under the remote write
      // lock on a cache miss — the first turn in a worktree after a server
      // restart would block on a remote round trip. Nothing here reads the
      // remote half, and in the common case (cache warm) it costs no spawn.
      //
      // Deliberate fail-open, not an oversight: if the status read fails we
      // cannot know HEAD, so the checkout/dirty guards degrade to "proceed".
      // Refusing instead would block every turn in the worktree on a transient
      // git hiccup. The busy guard above does NOT depend on this read, so the
      // concurrency protection — the one that prevents two agents fighting
      // over a checkout — still holds when this degrades.
      //
      // `Effect.catch` only, not `catchCause`: this fail-open covers a failed
      // status read, not a defect or this fiber's own interruption. Widening
      // it to `catchCause` would silently absorb both of those too.
      const status = yield* vcsStatus.getLocalStatus(worktreePath).pipe(
        Effect.catch((error) =>
          Effect.logWarning("stack turn guard could not read VCS status", {
            worktreePath,
            detail: error.message,
          }).pipe(Effect.as(null)),
        ),
      );

      const decision = decideWorktreeTurn({
        threadId,
        threadBranch: thread.value.branch,
        worktreePath,
        threads,
        headBranch: status?.refName ?? null,
        changedFileCount: status?.workingTree.files.length ?? 0,
      });

      switch (decision.kind) {
        case "proceed":
          return;
        case "busy":
          return yield* new StackWorktreeBusyError({
            worktreePath,
            blockingThreadId: decision.blockingThreadId,
            branch: decision.branch,
          });
        case "dirty":
          return yield* new StackWorktreeDirtyError({
            worktreePath,
            // NonNegativeInt is an unbranded Schema.Int check: plain number.
            headBranch: decision.headBranch,
            changedFileCount: decision.changedFileCount,
          });
        case "checkout": {
          const outcome = yield* stacks.withStackPermit(
            worktreePath,
            cli.runAction({
              cwd: worktreePath,
              action: "checkout",
              branch: decision.branch,
            }),
          );
          // The guard's whole purpose is that HEAD IS the thread's branch
          // before the agent runs. A checkout that did not happen must
          // refuse the turn, not wave it through onto the wrong branch.
          if (outcome._tag !== "ok") {
            return yield* new StackViewFailedError({
              worktreePath,
              detail:
                outcome._tag === "unavailable"
                  ? `Could not check out ${decision.branch}: ${outcome.reason}`
                  : `Could not check out ${decision.branch}: the worktree has conflicts`,
            });
          }
          yield* vcsStatus.refreshLocalStatus(worktreePath).pipe(Effect.ignore);
          // HEAD moved, so the cached chain is stale. Clearing it only:
          // the next subscriber's read refills it, no event is published.
          yield* stacks.invalidate(worktreePath);
          return;
        }
      }
    });

  return WorktreeTurnGuard.of({ ensureReady });
});

export const layer = Layer.effect(WorktreeTurnGuard, make);
