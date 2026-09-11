import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as GhStackCli from "./GhStackCli.ts";
import * as StackViewBroadcaster from "./StackViewBroadcaster.ts";

const viewOf = (branches: ReadonlyArray<string>) =>
  ({
    _tag: "view",
    raw: {
      trunk: "main",
      currentBranch: branches.at(-1) ?? "main",
      stackNumber: null,
      branches: branches.map((name) => ({ name, isQueued: false })),
    },
  }) as const;

const makeLayer = (view: GhStackCli.GhStackCli["Service"]["view"]) =>
  StackViewBroadcaster.layer.pipe(
    Layer.provide(
      Layer.mock(GhStackCli.GhStackCli)({
        view,
        runAction: () => Effect.succeed({ _tag: "ok" } as const),
      }),
    ),
  );

describe("StackViewBroadcaster", () => {
  it.effect("spawns gh once for repeated reads of the same worktree", () =>
    Effect.gen(function* () {
      const view = vi.fn(() => Effect.succeed(viewOf(["feat/base", "feat/top"])));

      yield* Effect.gen(function* () {
        const broadcaster = yield* StackViewBroadcaster.StackViewBroadcaster;

        const first = yield* broadcaster.getStack("/repo/wt");
        const second = yield* broadcaster.getStack("/repo/wt");

        assert.equal(view.mock.calls.length, 1);
        assert.equal(first._tag, "available");
        assert.deepStrictEqual(first, second);
        if (first._tag !== "available") return;
        assert.deepStrictEqual(first.layers, [
          { branch: "feat/base", position: 0 },
          { branch: "feat/top", position: 1 },
        ]);
      }).pipe(Effect.provide(makeLayer(view)));
    }),
  );

  it.effect("publishes only when the fingerprint changes", () =>
    Effect.gen(function* () {
      const branchesRef = { current: ["feat/base"] };
      const layer = makeLayer(() => Effect.succeed(viewOf(branchesRef.current)));

      yield* Effect.gen(function* () {
        const broadcaster = yield* StackViewBroadcaster.StackViewBroadcaster;
        const collected = yield* Stream.runCollect(
          broadcaster.streamStack({ worktreePath: "/repo/wt" }).pipe(Stream.take(2)),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        // Advance the clock so the next read's `observedAt` genuinely differs
        // from the initial one. Dedup must survive a changed timestamp, not
        // just an unchanged one under a frozen TestClock.
        yield* TestClock.adjust("1 second");

        // Same chain, later timestamp: no event.
        yield* broadcaster.refreshStack("/repo/wt");
        // Changed chain: one event.
        branchesRef.current = ["feat/base", "feat/top"];
        yield* broadcaster.refreshStack("/repo/wt");

        const events = yield* Fiber.join(collected);
        const layerCounts = [...events].map((event) =>
          event._tag === "available" ? event.layers.length : -1,
        );
        assert.deepStrictEqual(layerCounts, [1, 2]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("caches an unavailable stack for the TTL, then re-reads", () =>
    Effect.gen(function* () {
      const view = vi.fn(() =>
        Effect.succeed({ _tag: "unavailable", reason: "gh-missing" } as const),
      );

      yield* Effect.gen(function* () {
        const broadcaster = yield* StackViewBroadcaster.StackViewBroadcaster;
        yield* broadcaster.getStack("/repo/wt");
        yield* broadcaster.getStack("/repo/wt");
        assert.equal(view.mock.calls.length, 1);

        yield* TestClock.adjust(StackViewBroadcaster.STACK_UNAVAILABLE_TTL);
        yield* broadcaster.getStack("/repo/wt");
        assert.equal(view.mock.calls.length, 2);
      }).pipe(Effect.provide(makeLayer(view)));
    }),
  );

  it.effect("re-reads after an explicit invalidate", () =>
    Effect.gen(function* () {
      const view = vi.fn(() => Effect.succeed(viewOf(["feat/base"])));

      yield* Effect.gen(function* () {
        const broadcaster = yield* StackViewBroadcaster.StackViewBroadcaster;
        yield* broadcaster.getStack("/repo/wt");
        yield* broadcaster.invalidate("/repo/wt");
        yield* broadcaster.getStack("/repo/wt");
        assert.equal(view.mock.calls.length, 2);
      }).pipe(Effect.provide(makeLayer(view)));
    }),
  );

  it.effect("serializes work per worktree under one permit", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const broadcaster = yield* StackViewBroadcaster.StackViewBroadcaster;

      const slow = broadcaster.withStackPermit(
        "/repo/wt",
        Effect.sync(() => order.push("first-start")).pipe(
          Effect.flatMap(() => Effect.sleep("10 millis")),
          Effect.flatMap(() => Effect.sync(() => order.push("first-end"))),
        ),
      );
      const fast = broadcaster.withStackPermit(
        "/repo/wt",
        Effect.sync(() => order.push("second")),
      );

      const fiber = yield* Effect.forkChild(Effect.all([slow, fast], { concurrency: 2 }));
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(fiber);

      assert.deepStrictEqual(order, ["first-start", "first-end", "second"]);
    }).pipe(Effect.provide(makeLayer(() => Effect.succeed(viewOf(["feat/base"]))))),
  );
});
