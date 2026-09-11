import { assert, describe, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import type { WorktreeThreadFact } from "./StackActionRunner.ts";
import { decideWorktreeTurn } from "./WorktreeTurnGuard.ts";

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
