import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  CommandId,
  EventId,
  STACK_REBASE_ACTIVITY_KIND,
  StackActionConflictedError,
  StackViewFailedError,
  StackWorktreeBusyError,
  stackActionRewritesBranches,
  type StackActionKind,
  type StackActionResult,
  type ThreadId,
} from "@t3tools/contracts";

// Named export from Services/, not a namespace import of a top-level module:
// see CheckpointReactor.ts:33, ProviderCommandReactor.ts:44, http.ts:19.
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GhStackCli from "./GhStackCli.ts";
import * as StackViewBroadcaster from "./StackViewBroadcaster.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface WorktreeThreadFact {
  readonly id: ThreadId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
}

/**
 * The concurrency guard is a question about the read model, not a lock: no new
 * state to hold, nothing to release, nothing to repair after a server crash.
 */
export function findBusyWorktreeThread(input: {
  readonly worktreePath: string;
  readonly threads: ReadonlyArray<WorktreeThreadFact>;
  readonly excludeThreadId?: ThreadId | null;
}): WorktreeThreadFact | null {
  return (
    input.threads.find(
      (thread) =>
        thread.worktreePath === input.worktreePath &&
        thread.id !== input.excludeThreadId &&
        thread.latestTurnState === "running",
    ) ?? null
  );
}

/**
 * A rebase keeps every checkpoint alive — a checkpoint is a ref, so nothing
 * dangles — but it changes what a diff against an older one *means*: it now
 * mixes this thread's work with what the rebase pulled in from the layers
 * below. This activity is the boundary the restore confirmation reads.
 */
export function rebaseBoundaryActivity(input: {
  readonly action: "sync" | "rebaseUpstack";
  readonly trunk: string;
}): { readonly kind: string; readonly tone: "info"; readonly summary: string } {
  return {
    kind: STACK_REBASE_ACTIVITY_KIND,
    tone: "info",
    summary: `Stack rebased onto ${input.trunk}`,
  };
}

export class StackActionRunner extends Context.Service<
  StackActionRunner,
  {
    readonly run: (input: {
      readonly worktreePath: string;
      readonly action: StackActionKind;
      readonly branch?: string;
      readonly requestedByThreadId: ThreadId | null;
    }) => Effect.Effect<
      StackActionResult,
      StackViewFailedError | StackWorktreeBusyError | StackActionConflictedError
    >;
  }
>()("t3/stack/StackActionRunner") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const cli = yield* GhStackCli.GhStackCli;
  const broadcaster = yield* StackViewBroadcaster.StackViewBroadcaster;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  // Local id helpers, matching CheckpointReactor.ts:80-83 — there is no shared
  // export for these; each command-dispatching module defines its own.
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const worktreeThreads = (worktreePath: string) =>
    snapshots.getShellSnapshot().pipe(
      Effect.map((snapshot) =>
        snapshot.threads
          .filter((thread) => thread.worktreePath === worktreePath)
          .map((thread): WorktreeThreadFact => ({
            id: thread.id,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            latestTurnState: thread.latestTurn?.state ?? null,
          })),
      ),
      // A failed projection read must not become a silent green light: an
      // empty list here makes findBusyWorktreeThread return null and lets the
      // action run against a worktree that may have a live agent in it. Same
      // shape as WorktreeTurnGuard's own read of this snapshot.
      Effect.mapError(
        (cause) =>
          new StackViewFailedError({
            worktreePath,
            detail: `Could not read the worktree's threads: ${cause.message}`,
          }),
      ),
    );

  /**
   * A base branch with a merge queue takes the stack into the queue; saying
   * "merged" there would be a lie the user reads as done. The merge already
   * happened by the time this runs, so neither an unreadable chain nor a
   * failed read may fail the action — both resolve to "queued" instead.
   * Unknown defaults to queued in BOTH channels on purpose: reporting a
   * queued stack as merged hands the user a completion that nothing
   * corrects, while a stack that really landed reads as merged the moment
   * the row refreshes.
   */
  const isQueued = (worktreePath: string) => {
    const unknown = (detail: string) =>
      Effect.logWarning("could not tell a queued stack merge from a landed one", {
        worktreePath,
        detail,
      }).pipe(Effect.as(true));
    return cli.view({ cwd: worktreePath }).pipe(
      Effect.flatMap((outcome) =>
        outcome._tag === "view"
          ? Effect.succeed(outcome.raw.branches.some((branch) => branch.isQueued))
          : unknown(`gh stack view is unavailable: ${outcome.reason}`),
      ),
      Effect.catch((error) => unknown(error.message)),
    );
  };

  const appendActivity = (
    threadId: ThreadId,
    activity: { readonly kind: string; readonly tone: "info"; readonly summary: string },
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      return yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("stack-rebase-boundary"),
        threadId,
        createdAt,
        activity: {
          id: yield* serverEventId,
          tone: activity.tone,
          kind: activity.kind,
          summary: activity.summary,
          payload: {},
          turnId: null,
          createdAt,
        },
      });
    });

  const run: StackActionRunner["Service"]["run"] = (input) =>
    broadcaster.withStackPermit(
      input.worktreePath,
      Effect.gen(function* () {
        const threads = yield* worktreeThreads(input.worktreePath);
        const busy = findBusyWorktreeThread({
          worktreePath: input.worktreePath,
          threads,
          excludeThreadId: input.requestedByThreadId,
        });
        if (busy !== null) {
          return yield* new StackWorktreeBusyError({
            worktreePath: input.worktreePath,
            blockingThreadId: busy.id,
            branch: busy.branch,
          });
        }

        const outcome = yield* cli.runAction({
          cwd: input.worktreePath,
          action: input.action,
          ...(input.branch !== undefined ? { branch: input.branch } : {}),
        });

        if (outcome._tag === "conflicted") {
          // Refresh first: the chain may already have moved before the conflict.
          // `withinPermit`: this whole `run` is already inside `withStackPermit`
          // for this cwd — `refreshStack` would try to reacquire the same
          // (non-reentrant) permit and hang forever, still holding it.
          yield* broadcaster.refreshStackWithinPermit(input.worktreePath).pipe(Effect.ignore);
          return yield* new StackActionConflictedError({
            worktreePath: input.worktreePath,
            branch: input.branch ?? null,
            conflictedPaths: outcome.conflictedPaths,
          });
        }

        // `unavailable` is a displayable STATE on the read path and a FAILURE
        // here: the user asked for the action, and reporting success because
        // gh went missing would show "submitted" for a stack that never was.
        if (outcome._tag === "unavailable") {
          return yield* new StackViewFailedError({
            worktreePath: input.worktreePath,
            detail: `gh stack ${input.action} could not run: ${outcome.reason}`,
          });
        }

        // Signal 3: a stack.action run through T3 invalidates the cached chain.
        // `withinPermit`: see the comment on the conflict branch above — `run`
        // already holds this cwd's permit for the whole action.
        const status = yield* broadcaster.refreshStackWithinPermit(input.worktreePath);

        if (stackActionRewritesBranches(input.action) && status._tag === "available") {
          const activity = rebaseBoundaryActivity({
            action: input.action,
            trunk: status.trunk,
          });
          const branches = new Set(status.layers.map((layer) => layer.branch));
          const affected = threads.filter(
            (thread) => thread.branch !== null && branches.has(thread.branch),
          );
          yield* Effect.forEach(affected, (thread) => appendActivity(thread.id, activity), {
            discard: true,
          }).pipe(Effect.ignore({ log: true }));
        }

        const mergeDisposition =
          input.action !== "merge"
            ? null
            : (yield* isQueued(input.worktreePath))
              ? ("queued" as const)
              : ("merged" as const);

        return { action: input.action, mergeDisposition } satisfies StackActionResult;
      }),
    );

  return StackActionRunner.of({ run });
});

export const layer = Layer.effect(StackActionRunner, make);
