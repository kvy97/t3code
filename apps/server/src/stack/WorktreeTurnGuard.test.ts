import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type VcsStatusResult,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GhStackCli from "./GhStackCli.ts";
import type { WorktreeThreadFact } from "./StackActionRunner.ts";
import * as StackViewBroadcaster from "./StackViewBroadcaster.ts";
import {
  WorktreeTurnGuard,
  decideWorktreeTurn,
  layer as worktreeTurnGuardLayer,
} from "./WorktreeTurnGuard.ts";

const self = ThreadId.make("self");

const sibling = (patch: {
  id: string;
  latestTurnState?: WorktreeThreadFact["latestTurnState"];
}): WorktreeThreadFact => ({
  id: ThreadId.make(patch.id),
  branch: "feat/base",
  worktreePath: "/repo/wt",
  latestTurnState: patch.latestTurnState ?? "completed",
});

const base = {
  threadId: self,
  threadBranch: "feat/top",
  worktreePath: "/repo/wt" as string | null,
  threads: [] as ReadonlyArray<WorktreeThreadFact>,
  headBranch: "feat/top" as string | null,
  changedFileCount: 0,
};

describe("decideWorktreeTurn", () => {
  it("costs nothing when HEAD already matches", () => {
    assert.deepStrictEqual(decideWorktreeTurn(base), { kind: "proceed" });
  });

  it("refuses when a sibling of the same worktree is running", () => {
    const decision = decideWorktreeTurn({
      ...base,
      threads: [sibling({ id: "other", latestTurnState: "running" })],
    });

    assert.deepStrictEqual(decision, {
      kind: "busy",
      blockingThreadId: ThreadId.make("other"),
      branch: "feat/base",
    });
  });

  it("busy wins over a needed checkout", () => {
    const decision = decideWorktreeTurn({
      ...base,
      headBranch: "feat/base",
      threads: [sibling({ id: "other", latestTurnState: "running" })],
    });

    assert.equal(decision.kind, "busy");
  });

  it("refuses to move uncommitted work across branches", () => {
    const decision = decideWorktreeTurn({
      ...base,
      headBranch: "feat/base",
      changedFileCount: 3,
    });

    assert.deepStrictEqual(decision, {
      kind: "dirty",
      headBranch: "feat/base",
      changedFileCount: 3,
    });
  });

  it("lets a dirty tree run when HEAD is already the thread's branch", () => {
    const decision = decideWorktreeTurn({ ...base, changedFileCount: 3 });

    assert.deepStrictEqual(decision, { kind: "proceed" });
  });

  it("checks out the thread's branch on a clean mismatch", () => {
    const decision = decideWorktreeTurn({ ...base, headBranch: "feat/base" });

    assert.deepStrictEqual(decision, { kind: "checkout", branch: "feat/top" });
  });

  it("leaves a thread with no worktree alone", () => {
    const decision = decideWorktreeTurn({
      ...base,
      worktreePath: null,
      headBranch: "something-else",
      threads: [sibling({ id: "other", latestTurnState: "running" })],
    });

    assert.deepStrictEqual(decision, { kind: "proceed" });
  });

  it("leaves a branchless thread alone rather than guessing a branch", () => {
    const decision = decideWorktreeTurn({
      ...base,
      threadBranch: null,
      headBranch: "feat/base",
      changedFileCount: 4,
    });

    assert.deepStrictEqual(decision, { kind: "proceed" });
  });
});

const testThread: OrchestrationThreadShell = {
  id: self,
  projectId: ProjectId.make("p1"),
  title: "Test thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feat/top",
  worktreePath: "/repo/wt",
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const cleanMismatchedStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  // Mismatched against testThread.branch ("feat/top"): this is what makes
  // decideWorktreeTurn choose "checkout" rather than "proceed".
  refName: "feat/base",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

/**
 * `refreshLocalStatus` and `invalidate` are stubbed (not left unimplemented)
 * even though the fixed guard never reaches them on this test's failing
 * outcome: leaving them unimplemented would make an unfixed guard die on
 * `Layer.mock`'s "Unimplemented method" instead of actually reaching (and
 * failing at) the assertion that the turn was refused — a misleading RED.
 */
const guardLayerWithCheckoutOutcome = (
  outcome: GhStackCli.GhStackActionOutcome,
): Layer.Layer<WorktreeTurnGuard> =>
  worktreeTurnGuardLayer.pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeedSome(testThread),
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            projects: [],
            threads: [testThread],
            updatedAt: "2026-08-20T00:00:00.000Z",
          } satisfies OrchestrationShellSnapshot),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        getStatus: () => Effect.succeed(cleanMismatchedStatus),
        refreshLocalStatus: () => Effect.succeed(cleanMismatchedStatus),
      }),
    ),
    Layer.provide(
      Layer.mock(StackViewBroadcaster.StackViewBroadcaster)({
        withStackPermit: (_worktreePath, effect) => effect,
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(GhStackCli.GhStackCli)({
        runAction: () => Effect.succeed(outcome),
      }),
    ),
  );

describe("WorktreeTurnGuard.ensureReady", () => {
  it.effect("refuses the turn when the needed checkout did not happen", () =>
    Effect.gen(function* () {
      const guard = yield* WorktreeTurnGuard;
      const error = yield* Effect.flip(guard.ensureReady(self));

      if (error._tag !== "StackViewFailedError") {
        throw new Error(`expected StackViewFailedError, got ${error._tag}`);
      }
      assert.match(error.detail, /gh-missing/);
    }).pipe(
      Effect.provide(guardLayerWithCheckoutOutcome({ _tag: "unavailable", reason: "gh-missing" })),
    ),
  );
});
