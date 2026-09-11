import { assert, describe, expect, it } from "vite-plus/test";
import { STACK_REBASE_ACTIVITY_KIND, ThreadId } from "@t3tools/contracts";

import {
  findBusyWorktreeThread,
  rebaseBoundaryActivity,
  type WorktreeThreadFact,
} from "./StackActionRunner.ts";

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
