import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsFreshness } from "./vcs.ts";

/** One branch of a `gh stack`. `position` is 0 at the bottom, next to the trunk. */
export const StackLayer = Schema.Struct({
  branch: TrimmedNonEmptyString,
  position: NonNegativeInt,
});
export type StackLayer = typeof StackLayer.Type;

/**
 * Structure only. Per-layer PR and CI state is joined on the branch from the
 * pull request store T3 already refreshes, and `dirty`/`headBranch` come from
 * the VCS status for the same cwd. Two sources for one fact is a bug waiting.
 */
export const StackView = Schema.TaggedStruct("available", {
  worktreePath: TrimmedNonEmptyString,
  trunk: TrimmedNonEmptyString,
  /** The number GitHub's stack UI shows. `gh stack` v0.1.1 does not emit it. */
  stackNumber: Schema.NullOr(PositiveInt),
  layers: Schema.Array(StackLayer),
  freshness: VcsFreshness,
});
export type StackView = typeof StackView.Type;

export const StackUnavailableReason = Schema.Literals([
  "gh-missing",
  "extension-missing",
  "gh-unauthenticated",
  "not-a-stack",
  "conflicting-local-state",
]);
export type StackUnavailableReason = typeof StackUnavailableReason.Type;

/** Not an error: a displayable state. The sidebar degrades to worktree grouping. */
export const StackUnavailable = Schema.TaggedStruct("unavailable", {
  reason: StackUnavailableReason,
  freshness: VcsFreshness,
});
export type StackUnavailable = typeof StackUnavailable.Type;

export const StackStatus = Schema.Union([StackView, StackUnavailable]);
export type StackStatus = typeof StackStatus.Type;

export const StackViewInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
});
export type StackViewInput = typeof StackViewInput.Type;

export const StackActionKind = Schema.Literals([
  "checkout",
  "addLayer",
  "submit",
  "sync",
  "rebaseUpstack",
  "merge",
]);
export type StackActionKind = typeof StackActionKind.Type;

export const StackActionInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  action: StackActionKind,
  /** Required by `checkout` and `addLayer`, meaningless for the other four. */
  branch: Schema.optional(TrimmedNonEmptyString),
});
export type StackActionInput = typeof StackActionInput.Type;

export const StackActionResult = Schema.Struct({
  action: StackActionKind,
  /**
   * `merge` only. A base branch with a merge queue takes the stack into the
   * queue instead of landing it, and the UI must say "queued", not "merged".
   */
  mergeDisposition: Schema.NullOr(Schema.Literals(["merged", "queued"])),
});
export type StackActionResult = typeof StackActionResult.Type;

/** The activity kind that marks a rebase boundary on a thread. Lives here so
    the server writes it and the client reads it from one definition. */
export const STACK_REBASE_ACTIVITY_KIND = "stack.rebased";

/** True for the actions that rewrite local branch history, which is what puts
    a boundary on this worktree's checkpoints. A predicate, not a boolean, so
    the caller that builds the boundary keeps the narrowed action type. */
export function stackActionRewritesBranches(
  action: StackActionKind,
): action is "sync" | "rebaseUpstack" {
  return action === "sync" || action === "rebaseUpstack";
}

const stackErrorFields = {
  worktreePath: Schema.String,
} as const;

/** `gh` failed in a way no `StackUnavailableReason` describes honestly:
    truncated output, an undecodable payload, a missing exit code. */
export class StackViewFailedError extends Schema.TaggedError<StackViewFailedError>()(
  "StackViewFailedError",
  { ...stackErrorFields, detail: Schema.String },
) {
  override get message(): string {
    return `Could not read the stack for ${this.worktreePath}: ${this.detail}`;
  }
}

export class StackWorktreeBusyError extends Schema.TaggedError<StackWorktreeBusyError>()(
  "StackWorktreeBusyError",
  {
    ...stackErrorFields,
    blockingThreadId: ThreadId,
    branch: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Another thread is running in ${this.worktreePath}. Interrupt it before starting this turn.`;
  }
}

export class StackWorktreeDirtyError extends Schema.TaggedError<StackWorktreeDirtyError>()(
  "StackWorktreeDirtyError",
  {
    ...stackErrorFields,
    headBranch: Schema.String,
    changedFileCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `${this.worktreePath} has ${this.changedFileCount} uncommitted change(s) on ${this.headBranch}. Commit or discard them, then start the turn.`;
  }
}

export class StackActionConflictedError extends Schema.TaggedError<StackActionConflictedError>()(
  "StackActionConflictedError",
  {
    ...stackErrorFields,
    branch: Schema.NullOr(Schema.String),
    conflictedPaths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `The stack action left conflicts in ${this.worktreePath}. Resolve them in that worktree's terminal.`;
  }
}

export const StackError = Schema.Union([
  StackViewFailedError,
  StackWorktreeBusyError,
  StackWorktreeDirtyError,
  StackActionConflictedError,
]);
export type StackError = typeof StackError.Type;
