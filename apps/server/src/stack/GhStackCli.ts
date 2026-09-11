import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  StackViewFailedError,
  type StackActionKind,
  type StackUnavailableReason,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
/** `gh stack sync` and `merge` reach the network; give them more rope than a read. */
const ACTION_TIMEOUT_MS = 120_000;

/**
 * `gh` core honours GH_PROMPT_DISABLED. Whether the extension binary does is
 * not guaranteed, so the closed stdin and the VcsProcess timeout are what
 * actually stop a prompt from hanging a turn; a hang surfaces as
 * `conflicting-local-state` with the `gh stack unstack --local` remediation.
 */
const NON_INTERACTIVE_ENV = { GH_PROMPT_DISABLED: "1" } as const;

export function ghStackArgs(action: StackActionKind, branch?: string): ReadonlyArray<string> {
  switch (action) {
    case "checkout":
      return ["stack", "checkout", branch ?? ""];
    case "addLayer":
      return ["stack", "add", branch ?? ""];
    case "submit":
      return ["stack", "submit", "--auto"];
    case "sync":
      return ["stack", "sync"];
    case "rebaseUpstack":
      return ["stack", "rebase", "--upstack"];
    case "merge":
      return ["stack", "merge", "--yes"];
  }
}

export type GhStackExitClass =
  | { readonly _tag: "ok" }
  | { readonly _tag: "unavailable"; readonly reason: StackUnavailableReason }
  | { readonly _tag: "conflicted" }
  | { readonly _tag: "unclassified"; readonly detail: string };

const MAX_DETAIL_LENGTH = 400;

export function classifyGhStackExit(output: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): GhStackExitClass {
  if (output.exitCode === 0) return { _tag: "ok" };
  const stderr = output.stderr.toLowerCase();
  if (stderr.includes('unknown command "stack"')) {
    return { _tag: "unavailable", reason: "extension-missing" };
  }
  if (stderr.includes("gh auth login") || stderr.includes("not logged in")) {
    return { _tag: "unavailable", reason: "gh-unauthenticated" };
  }
  if (stderr.includes("conflict")) {
    return { _tag: "conflicted" };
  }
  if (stderr.includes("not part of a stack") || stderr.includes("no stack")) {
    return { _tag: "unavailable", reason: "not-a-stack" };
  }
  return { _tag: "unclassified", detail: output.stderr.slice(0, MAX_DETAIL_LENGTH) };
}

/** A missing executable and a timeout are the only VcsErrors that describe a
    stack state rather than a bug; everything else is a real failure. */
function classifyGhStackVcsError(
  error: VcsError,
): { readonly reason: StackUnavailableReason } | { readonly detail: string } {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  ) {
    return { reason: "gh-missing" };
  }
  if (error._tag === "VcsProcessTimeoutError") {
    return { reason: "conflicting-local-state" };
  }
  return { detail: error.message.slice(0, MAX_DETAIL_LENGTH) };
}

const RawGhStackBranch = Schema.Struct({
  name: Schema.String,
  isQueued: Schema.optional(Schema.Boolean),
});

const RawGhStackView = Schema.Struct({
  trunk: Schema.String,
  currentBranch: Schema.optional(Schema.String),
  stackNumber: Schema.optional(Schema.NullOr(Schema.Number)),
  branches: Schema.Array(RawGhStackBranch),
});

const decodeRawGhStackView = Schema.decodeUnknownEffect(Schema.fromJsonString(RawGhStackView));

export interface GhStackRawView {
  readonly trunk: string;
  readonly currentBranch: string;
  readonly stackNumber: number | null;
  readonly branches: ReadonlyArray<{ readonly name: string; readonly isQueued: boolean }>;
}

export type GhStackViewOutcome =
  | { readonly _tag: "view"; readonly raw: GhStackRawView }
  | { readonly _tag: "unavailable"; readonly reason: StackUnavailableReason };

export type GhStackActionOutcome =
  | { readonly _tag: "ok" }
  | { readonly _tag: "unavailable"; readonly reason: StackUnavailableReason }
  | { readonly _tag: "conflicted"; readonly conflictedPaths: ReadonlyArray<string> };

export class GhStackCli extends Context.Service<
  GhStackCli,
  {
    readonly view: (input: {
      readonly cwd: string;
    }) => Effect.Effect<GhStackViewOutcome, StackViewFailedError>;

    readonly runAction: (input: {
      readonly cwd: string;
      readonly action: StackActionKind;
      readonly branch?: string;
    }) => Effect.Effect<GhStackActionOutcome, StackViewFailedError>;
  }
>()("t3/stack/GhStackCli") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const runGh = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs: number;
  }) =>
    process.run({
      operation: input.operation,
      command: "gh",
      args: input.args,
      cwd: input.cwd,
      stdin: "",
      env: { ...NON_INTERACTIVE_ENV },
      allowNonZeroExit: true,
      timeoutMs: input.timeoutMs,
    });

  const unmergedPaths = (cwd: string) =>
    process
      .run({
        operation: "GhStackCli.unmergedPaths",
        command: "git",
        args: ["diff", "--name-only", "--diff-filter=U"],
        cwd,
        stdin: "",
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

  const view: GhStackCli["Service"]["view"] = (input) =>
    runGh({
      operation: "GhStackCli.view",
      cwd: input.cwd,
      args: ["stack", "view", "--json"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }).pipe(
      Effect.matchEffect({
        // Explicit return types on these two callbacks are load-bearing
        // here: left uninferred, this pair of branches spills the
        // requirements channel to `unknown` instead of `never`. Other
        // matchEffect callbacks in this repo infer fine — do not read this
        // as a rule about matchEffect.
        onFailure: (error): Effect.Effect<GhStackViewOutcome, StackViewFailedError> => {
          const classified = classifyGhStackVcsError(error);
          return "reason" in classified
            ? Effect.succeed({ _tag: "unavailable", reason: classified.reason } as const)
            : Effect.fail(
                new StackViewFailedError({ worktreePath: input.cwd, detail: classified.detail }),
              );
        },
        onSuccess: (result): Effect.Effect<GhStackViewOutcome, StackViewFailedError> => {
          const classified = classifyGhStackExit(result);
          if (classified._tag === "unavailable") {
            return Effect.succeed({ _tag: "unavailable", reason: classified.reason } as const);
          }
          // A read cannot conflict; treat it like any other unexplained failure.
          if (classified._tag !== "ok") {
            const detail =
              classified._tag === "unclassified" ? classified.detail : "gh reported a conflict";
            return Effect.fail(new StackViewFailedError({ worktreePath: input.cwd, detail }));
          }
          return decodeRawGhStackView(result.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new StackViewFailedError({
                  worktreePath: input.cwd,
                  detail: `gh stack view returned unexpected JSON: ${String(cause)}`.slice(
                    0,
                    MAX_DETAIL_LENGTH,
                  ),
                }),
            ),
            Effect.map(
              (raw) =>
                ({
                  _tag: "view",
                  raw: {
                    trunk: raw.trunk,
                    currentBranch: raw.currentBranch ?? "",
                    stackNumber: raw.stackNumber ?? null,
                    branches: raw.branches.map((branch) => ({
                      name: branch.name,
                      isQueued: branch.isQueued ?? false,
                    })),
                  },
                }) as const,
            ),
          );
        },
      }),
    );

  const runAction: GhStackCli["Service"]["runAction"] = (input) =>
    runGh({
      operation: "GhStackCli.runAction",
      cwd: input.cwd,
      args: ghStackArgs(input.action, input.branch),
      timeoutMs: ACTION_TIMEOUT_MS,
    }).pipe(
      Effect.matchEffect({
        // See the comment on the same spot in `view`: the annotations pin
        // matchEffect's per-callback generics to the full outcome union so
        // the requirements channel resolves to `never`, not `unknown`.
        onFailure: (error): Effect.Effect<GhStackActionOutcome, StackViewFailedError> => {
          const classified = classifyGhStackVcsError(error);
          return "reason" in classified
            ? Effect.succeed({ _tag: "unavailable", reason: classified.reason } as const)
            : Effect.fail(
                new StackViewFailedError({ worktreePath: input.cwd, detail: classified.detail }),
              );
        },
        onSuccess: (result): Effect.Effect<GhStackActionOutcome, StackViewFailedError> => {
          const classified = classifyGhStackExit(result);
          switch (classified._tag) {
            case "ok":
              return Effect.succeed({ _tag: "ok" } as const);
            case "unavailable":
              return Effect.succeed({ _tag: "unavailable", reason: classified.reason } as const);
            case "conflicted":
              return unmergedPaths(input.cwd).pipe(
                Effect.map((conflictedPaths) => ({ _tag: "conflicted", conflictedPaths }) as const),
              );
            case "unclassified":
              return Effect.fail(
                new StackViewFailedError({
                  worktreePath: input.cwd,
                  detail: classified.detail,
                }),
              );
          }
        },
      }),
    );

  return GhStackCli.of({ view, runAction });
});

export const layer = Layer.effect(GhStackCli, make);
