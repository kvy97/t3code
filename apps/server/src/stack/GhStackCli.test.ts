import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessSpawnError, VcsProcessTimeoutError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GhStackCli from "./GhStackCli.ts";

const output = (patch: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(patch.exitCode ?? 0),
  stdout: patch.stdout ?? "",
  stderr: patch.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const layer = GhStackCli.layer.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
);

afterEach(() => {
  mockRun.mockReset();
});

describe("ghStackArgs", () => {
  it("hard-codes the non-interactive flag for every action", () => {
    expect(GhStackCli.ghStackArgs("checkout", "feat/top")).toEqual([
      "stack",
      "checkout",
      "feat/top",
    ]);
    expect(GhStackCli.ghStackArgs("addLayer", "feat/top")).toEqual(["stack", "add", "feat/top"]);
    expect(GhStackCli.ghStackArgs("submit")).toEqual(["stack", "submit", "--auto"]);
    expect(GhStackCli.ghStackArgs("sync")).toEqual(["stack", "sync"]);
    expect(GhStackCli.ghStackArgs("rebaseUpstack")).toEqual(["stack", "rebase", "--upstack"]);
    expect(GhStackCli.ghStackArgs("merge")).toEqual(["stack", "merge", "--yes"]);
  });
});

describe("classifyGhStackExit", () => {
  it("reads the real gh messages", () => {
    expect(GhStackCli.classifyGhStackExit({ exitCode: 0, stdout: "{}", stderr: "" })).toEqual({
      _tag: "ok",
    });
    expect(
      GhStackCli.classifyGhStackExit({
        exitCode: 1,
        stdout: "",
        stderr: 'unknown command "stack" for "gh"',
      }),
    ).toEqual({ _tag: "unavailable", reason: "extension-missing" });
    expect(
      GhStackCli.classifyGhStackExit({
        exitCode: 2,
        stdout: "",
        stderr: '✗ current branch "main" is not part of a stack',
      }),
    ).toEqual({ _tag: "unavailable", reason: "not-a-stack" });
    expect(
      GhStackCli.classifyGhStackExit({
        exitCode: 4,
        stdout: "",
        stderr: "gh: To get started with GitHub CLI, please run: gh auth login",
      }),
    ).toEqual({ _tag: "unavailable", reason: "gh-unauthenticated" });
    expect(
      GhStackCli.classifyGhStackExit({
        exitCode: 1,
        stdout: "",
        stderr: "CONFLICT (content): Merge conflict in src/app.ts",
      })._tag,
    ).toBe("conflicted");
  });

  it("does not invent a reason for an unrecognized failure", () => {
    const classified = GhStackCli.classifyGhStackExit({
      exitCode: 9,
      stdout: "",
      stderr: "something nobody predicted",
    });

    assert.equal(classified._tag, "unclassified");
  });
});

describe("GhStackCli.view", () => {
  it.effect("decodes the stack bottom-to-top", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output({
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            stdout: JSON.stringify({
              trunk: "main",
              currentBranch: "feat/top",
              branches: [
                { name: "feat/base", isCurrent: false, isQueued: false },
                { name: "feat/top", isCurrent: true, isQueued: false },
              ],
            }),
          }),
        ),
      );

      const cli = yield* GhStackCli.GhStackCli;
      const outcome = yield* cli.view({ cwd: "/repo/wt" });

      assert.equal(outcome._tag, "view");
      if (outcome._tag !== "view") return;
      assert.deepStrictEqual(
        outcome.raw.branches.map((branch) => branch.name),
        ["feat/base", "feat/top"],
      );
      assert.equal(outcome.raw.trunk, "main");
      assert.equal(outcome.raw.stackNumber, null);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("closes stdin and disables prompting on every call", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(output({ exitCode: 2, stderr: "is not part of a stack" })),
      );

      const cli = yield* GhStackCli.GhStackCli;
      yield* cli.view({ cwd: "/repo/wt" });

      const call = mockRun.mock.calls[0]?.[0];
      assert.equal(call?.command, "gh");
      assert.equal(call?.stdin, "");
      assert.equal(call?.allowNonZeroExit, true);
      assert.equal(call?.env?.GH_PROMPT_DISABLED, "1");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("maps a missing gh executable to gh-missing", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessSpawnError({
            operation: "GhStackCli.view",
            command: "gh",
            cwd: "/repo/wt",
            cause: PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: "gh",
            }),
          }),
        ),
      );

      const cli = yield* GhStackCli.GhStackCli;
      const outcome = yield* cli.view({ cwd: "/repo/wt" });

      assert.deepStrictEqual(outcome, { _tag: "unavailable", reason: "gh-missing" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("maps a timeout to conflicting-local-state rather than hanging", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessTimeoutError({
            operation: "GhStackCli.view",
            command: "gh",
            cwd: "/repo/wt",
            timeoutMs: 30_000,
          }),
        ),
      );

      const cli = yield* GhStackCli.GhStackCli;
      const outcome = yield* cli.view({ cwd: "/repo/wt" });

      assert.deepStrictEqual(outcome, { _tag: "unavailable", reason: "conflicting-local-state" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails loudly when the JSON shape drifts", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(output({ stdout: '{"trunk":42}' })));

      const cli = yield* GhStackCli.GhStackCli;
      const exit = yield* Effect.exit(cli.view({ cwd: "/repo/wt" }));

      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(layer)),
  );
});

describe("GhStackCli.runAction", () => {
  it.effect("reads unmerged paths from git after a conflict", () =>
    Effect.gen(function* () {
      mockRun
        .mockReturnValueOnce(
          Effect.succeed(
            output({ exitCode: 1, stderr: "CONFLICT (content): Merge conflict in src/app.ts" }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output({ stdout: "src/app.ts\nsrc/other.ts\n" })));

      const cli = yield* GhStackCli.GhStackCli;
      const outcome = yield* cli.runAction({ cwd: "/repo/wt", action: "sync" });

      assert.equal(outcome._tag, "conflicted");
      if (outcome._tag !== "conflicted") return;
      assert.deepStrictEqual(outcome.conflictedPaths, ["src/app.ts", "src/other.ts"]);
      assert.deepStrictEqual(mockRun.mock.calls[1]?.[0]?.args, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
