import { assert, describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  ProjectId,
  ProviderInstanceId,
  STACK_REBASE_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type StackStatus,
} from "@t3tools/contracts";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as GhStackCli from "./GhStackCli.ts";
import {
  StackActionRunner,
  findBusyWorktreeThread,
  layer as stackActionRunnerLayer,
  rebaseBoundaryActivity,
  type WorktreeThreadFact,
} from "./StackActionRunner.ts";
import * as StackViewBroadcaster from "./StackViewBroadcaster.ts";

const thread = (
  patch: Omit<Partial<WorktreeThreadFact>, "id"> & { id: string },
): WorktreeThreadFact => ({
  id: ThreadId.make(patch.id),
  branch: patch.branch ?? null,
  worktreePath: patch.worktreePath ?? "/repo/wt",
  latestTurnState: patch.latestTurnState ?? "completed",
});

describe("findBusyWorktreeThread", () => {
  it("finds a running sibling in the same worktree", () => {
    const busy = findBusyWorktreeThread({
      worktreePath: "/repo/wt",
      threads: [
        thread({ id: "a", branch: "feat/base", latestTurnState: "running" }),
        thread({ id: "b", branch: "feat/top" }),
      ],
      excludeThreadId: ThreadId.make("b"),
    });

    assert.equal(busy?.id, "a");
  });

  it("ignores a running thread in a different worktree", () => {
    const busy = findBusyWorktreeThread({
      worktreePath: "/repo/wt",
      threads: [thread({ id: "a", worktreePath: "/repo/other", latestTurnState: "running" })],
    });

    assert.equal(busy, null);
  });

  it("does not report the requesting thread as its own blocker", () => {
    const busy = findBusyWorktreeThread({
      worktreePath: "/repo/wt",
      threads: [thread({ id: "a", latestTurnState: "running" })],
      excludeThreadId: ThreadId.make("a"),
    });

    assert.equal(busy, null);
  });

  it("treats an interrupted or errored turn as free", () => {
    for (const state of ["interrupted", "completed", "error"] as const) {
      const busy = findBusyWorktreeThread({
        worktreePath: "/repo/wt",
        threads: [thread({ id: "a", latestTurnState: state })],
      });
      assert.equal(busy, null, state);
    }
  });
});

describe("rebaseBoundaryActivity", () => {
  it("names the trunk the stack was rebased onto", () => {
    const activity = rebaseBoundaryActivity({ action: "sync", trunk: "main" });

    expect(activity.kind).toBe(STACK_REBASE_ACTIVITY_KIND);
    expect(activity.tone).toBe("info");
    expect(activity.summary).toBe("Stack rebased onto main");
  });
});

const worktreePath = "/repo/wt";

const shell = (patch: {
  readonly id: string;
  readonly branch?: string | null;
  readonly running?: boolean;
}): OrchestrationThreadShell => ({
  id: ThreadId.make(patch.id),
  projectId: ProjectId.make("p1"),
  title: patch.id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: patch.branch ?? null,
  worktreePath,
  latestTurn:
    patch.running === true
      ? {
          turnId: TurnId.make(`turn-${patch.id}`),
          state: "running",
          requestedAt: "2026-09-01T00:00:00.000Z",
          startedAt: "2026-09-01T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        }
      : null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const snapshotOf = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 0,
  projects: [],
  threads,
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const availableStatus = (branches: ReadonlyArray<string>): StackStatus => ({
  _tag: "available",
  worktreePath,
  trunk: "main",
  stackNumber: null,
  layers: branches.map((branch, position) => ({ branch, position })),
  freshness: {
    source: "live-local",
    observedAt: DateTime.makeUnsafe("2026-09-01T00:00:00.000Z"),
    expiresAt: Option.none(),
  },
});

const viewOf = (branches: ReadonlyArray<{ readonly name: string; readonly isQueued: boolean }>) =>
  ({
    _tag: "view",
    raw: { trunk: "main", currentBranch: "main", stackNumber: null, branches },
  }) as const;

/**
 * Mocked at the `gh` boundary only. `Layer.mock` dies on any method left
 * unimplemented, which is the assertion for two of the cases below: a `run`
 * that spawns `gh` after refusing, or that calls `refreshStack` instead of
 * `refreshStackWithinPermit` (which would deadlock on this cwd's own
 * non-reentrant permit in production), fails loudly instead of passing.
 */
const runnerLayer = (input: {
  readonly cli: Partial<GhStackCli.GhStackCli["Service"]>;
  readonly snapshot?: Effect.Effect<OrchestrationShellSnapshot, PersistenceSqlError>;
  readonly refreshed?: StackStatus;
  readonly dispatched?: Array<OrchestrationCommand>;
}): Layer.Layer<StackActionRunner> =>
  stackActionRunnerLayer.pipe(
    Layer.provide(Layer.mock(GhStackCli.GhStackCli)(input.cli)),
    Layer.provide(
      Layer.mock(StackViewBroadcaster.StackViewBroadcaster)({
        withStackPermit: (_worktreePath, effect) => effect,
        refreshStackWithinPermit: () =>
          Effect.succeed(input.refreshed ?? availableStatus(["feat/base", "feat/top"])),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          input.snapshot ?? Effect.succeed(snapshotOf([shell({ id: "self", branch: "feat/top" })])),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            input.dispatched?.push(command);
            return { sequence: input.dispatched?.length ?? 0 };
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );

describe("StackActionRunner.run", () => {
  it.effect("refuses to act on a worktree with a running sibling", () =>
    Effect.gen(function* () {
      const runner = yield* StackActionRunner;
      const error = yield* Effect.flip(
        runner.run({ worktreePath, action: "sync", requestedByThreadId: ThreadId.make("self") }),
      );

      assert.equal(error._tag, "StackWorktreeBusyError");
      if (error._tag !== "StackWorktreeBusyError") return;
      assert.equal(error.blockingThreadId, "other");
      assert.equal(error.branch, "feat/base");
    }).pipe(
      Effect.provide(
        runnerLayer({
          // `runAction` is left unimplemented: reaching gh at all would mean
          // the busy guard did not refuse.
          cli: {},
          snapshot: Effect.succeed(
            snapshotOf([
              shell({ id: "self", branch: "feat/top" }),
              shell({ id: "other", branch: "feat/base", running: true }),
            ]),
          ),
        }),
      ),
    ),
  );

  it.effect("refuses rather than acting when the worktree's thread read fails", () =>
    Effect.gen(function* () {
      const runner = yield* StackActionRunner;
      const error = yield* Effect.flip(
        runner.run({ worktreePath, action: "sync", requestedByThreadId: null }),
      );

      // An empty list here would make the busy check pass and run the action
      // against a worktree that may have a live agent in it.
      assert.equal(error._tag, "StackViewFailedError");
    }).pipe(
      Effect.provide(
        runnerLayer({
          cli: {},
          snapshot: Effect.fail(
            new PersistenceSqlError({
              operation: "getShellSnapshot",
              detail: "not modeled in this test",
            }),
          ),
        }),
      ),
    ),
  );

  it.effect("fails the action when gh itself is unavailable", () =>
    Effect.gen(function* () {
      const runner = yield* StackActionRunner;
      const error = yield* Effect.flip(
        runner.run({ worktreePath, action: "submit", requestedByThreadId: null }),
      );

      // Displayable state on the read path, a failure here: reporting success
      // would show "submitted" for a stack that never was.
      assert.equal(error._tag, "StackViewFailedError");
      if (error._tag !== "StackViewFailedError") return;
      assert.match(error.detail, /gh-missing/);
    }).pipe(
      Effect.provide(
        runnerLayer({
          cli: {
            runAction: () => Effect.succeed({ _tag: "unavailable", reason: "gh-missing" } as const),
          },
        }),
      ),
    ),
  );

  it.effect("reports a conflict with its paths", () =>
    Effect.gen(function* () {
      const runner = yield* StackActionRunner;
      const error = yield* Effect.flip(
        runner.run({
          worktreePath,
          action: "checkout",
          branch: "feat/base",
          requestedByThreadId: null,
        }),
      );

      assert.equal(error._tag, "StackActionConflictedError");
      if (error._tag !== "StackActionConflictedError") return;
      assert.equal(error.branch, "feat/base");
      assert.deepStrictEqual([...error.conflictedPaths], ["src/a.ts", "src/b.ts"]);
    }).pipe(
      Effect.provide(
        runnerLayer({
          cli: {
            runAction: () =>
              Effect.succeed({
                _tag: "conflicted",
                conflictedPaths: ["src/a.ts", "src/b.ts"],
              } as const),
          },
        }),
      ),
    ),
  );

  it.effect("tells a queued merge apart from a landed one", () =>
    Effect.gen(function* () {
      const runner = yield* StackActionRunner;
      const result = yield* runner.run({
        worktreePath,
        action: "merge",
        requestedByThreadId: null,
      });

      assert.deepStrictEqual(result, { action: "merge", mergeDisposition: "queued" });
    }).pipe(
      Effect.provide(
        runnerLayer({
          cli: {
            runAction: () => Effect.succeed({ _tag: "ok" } as const),
            view: () => Effect.succeed(viewOf([{ name: "feat/base", isQueued: true }])),
          },
        }),
      ),
    ),
  );

  it.effect("reports a merge that actually landed as merged", () =>
    Effect.gen(function* () {
      const runner = yield* StackActionRunner;
      const result = yield* runner.run({
        worktreePath,
        action: "merge",
        requestedByThreadId: null,
      });

      assert.deepStrictEqual(result, { action: "merge", mergeDisposition: "merged" });
    }).pipe(
      Effect.provide(
        runnerLayer({
          cli: {
            runAction: () => Effect.succeed({ _tag: "ok" } as const),
            view: () => Effect.succeed(viewOf([{ name: "feat/base", isQueued: false }])),
          },
        }),
      ),
    ),
  );
});

describe("StackActionRunner.run rebase boundary", () => {
  const dispatched: Array<OrchestrationCommand> = [];

  it.effect("marks only the threads whose branch is a layer of the refreshed chain", () =>
    Effect.gen(function* () {
      const runner = yield* StackActionRunner;
      const result = yield* runner.run({
        worktreePath,
        action: "sync",
        requestedByThreadId: null,
      });

      assert.deepStrictEqual(result, { action: "sync", mergeDisposition: null });
      assert.deepStrictEqual(
        dispatched.map((command) => command.type),
        ["thread.activity.append"],
      );
      const [command] = dispatched;
      assert.equal(command?.type === "thread.activity.append" ? command.threadId : null, "layer");
      assert.equal(
        command?.type === "thread.activity.append" ? command.activity.kind : null,
        STACK_REBASE_ACTIVITY_KIND,
      );
    }).pipe(
      Effect.provide(
        runnerLayer({
          cli: { runAction: () => Effect.succeed({ _tag: "ok" } as const) },
          snapshot: Effect.succeed(
            snapshotOf([
              shell({ id: "layer", branch: "feat/base" }),
              shell({ id: "unrelated", branch: "feat/elsewhere" }),
            ]),
          ),
          refreshed: availableStatus(["feat/base"]),
          dispatched,
        }),
      ),
    ),
  );
});
