import { describe, expect, it } from "vite-plus/test";

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { StackStatus } from "@t3tools/contracts";

import { resolveAdjacentThreadId, type SidebarListItem } from "./Sidebar.logic";
import {
  buildStackGroups,
  collectHiddenStackMemberKeys,
  insertStackGroupsIntoSidebarItems,
  resolveStackDragRunKeys,
  stackMarkerId,
  type StackGroupSource,
} from "./Sidebar.stack.logic";

// Type-side fixture: `VcsFreshness.expiresAt` is an Option of DateTime.Utc, so
// a hand-written JSON literal neither typechecks nor decodes. See Task 1.
const freshness = {
  source: "live-local" as const,
  observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
  expiresAt: Option.none<DateTime.Utc>(),
};

const available = (
  branches: ReadonlyArray<string>,
  stackNumber: number | null = null,
): StackStatus => ({
  _tag: "available",
  worktreePath: "/repo/wt",
  trunk: "main",
  stackNumber,
  layers: branches.map((branch, position) => ({ branch, position })),
  freshness,
});

const source = (patch: Partial<StackGroupSource>): StackGroupSource => ({
  worktreePath: "/repo/wt",
  status: available(["feat/base", "feat/top"]),
  members: [
    { key: "e1:t-top", branch: "feat/top", section: "active" },
    { key: "e1:t-base", branch: "feat/base", section: "active" },
  ],
  collapsed: false,
  checkedOutBranch: "feat/top",
  routeKey: null,
  ...patch,
});

describe("buildStackGroups", () => {
  it("orders members bottom-to-top from the chain, not from the thread list", () => {
    const [group] = buildStackGroups([source({})]);

    expect(group?.memberKeys).toEqual(["e1:t-base", "e1:t-top"]);
    expect(group?.layerCount).toBe(2);
  });

  it("keeps a thread whose branch is not a layer, after the matched ones", () => {
    const [group] = buildStackGroups([
      source({
        members: [
          { key: "e1:t-stray", branch: "feat/unrelated", section: "active" },
          { key: "e1:t-top", branch: "feat/top", section: "active" },
          { key: "e1:t-base", branch: "feat/base", section: "active" },
        ],
      }),
    ]);

    expect(group?.memberKeys).toEqual(["e1:t-base", "e1:t-top", "e1:t-stray"]);
  });

  it("homes the group in its most active member's section", () => {
    const pinned = buildStackGroups([
      source({
        members: [
          { key: "e1:t-base", branch: "feat/base", section: "settled" },
          { key: "e1:t-top", branch: "feat/top", section: "pinned" },
        ],
      }),
    ]);
    expect(pinned[0]?.section).toBe("pinned");

    const active = buildStackGroups([
      source({
        members: [
          { key: "e1:t-base", branch: "feat/base", section: "settled" },
          { key: "e1:t-top", branch: "feat/top", section: "active" },
        ],
      }),
    ]);
    expect(active[0]?.section).toBe("active");
  });

  it("drops the whole group into settled once every member settles", () => {
    const [group] = buildStackGroups([
      source({
        members: [
          { key: "e1:t-base", branch: "feat/base", section: "settled" },
          { key: "e1:t-top", branch: "feat/top", section: "settled" },
        ],
      }),
    ]);

    expect(group?.section).toBe("settled");
    expect(group?.memberKeys).toEqual(["e1:t-base", "e1:t-top"]);
  });

  it("leaves a snoozed member on its shelf instead of in the group", () => {
    const [group] = buildStackGroups([
      source({
        members: [
          { key: "e1:t-base", branch: "feat/base", section: "snoozed" },
          { key: "e1:t-top", branch: "feat/top", section: "active" },
        ],
      }),
    ]);

    expect(group?.memberKeys).toEqual(["e1:t-top"]);
  });

  it("collapses to the checked-out layer only", () => {
    const [group] = buildStackGroups([source({ collapsed: true })]);

    expect(group?.visibleMemberKeys).toEqual(["e1:t-top"]);
    expect(group?.hiddenMemberKeys).toEqual(["e1:t-base"]);
  });

  it("never hides the open thread behind a collapsed group", () => {
    const [group] = buildStackGroups([source({ collapsed: true, routeKey: "e1:t-base" })]);

    expect(group?.visibleMemberKeys).toEqual(["e1:t-base"]);
  });

  it("falls back to the bottom layer when nothing is checked out", () => {
    const [group] = buildStackGroups([source({ collapsed: true, checkedOutBranch: null })]);

    expect(group?.visibleMemberKeys).toEqual(["e1:t-base"]);
  });

  it("degrades to creation order and no actions without gh", () => {
    const [group] = buildStackGroups([
      source({
        status: { _tag: "unavailable", reason: "gh-missing", freshness } satisfies StackStatus,
      }),
    ]);

    expect(group?.unavailableReason).toBe("gh-missing");
    expect(group?.memberKeys).toEqual(["e1:t-top", "e1:t-base"]);
    expect(group?.layerCount).toBe(0);
  });

  it("does not group a lone thread", () => {
    const groups = buildStackGroups([
      source({ members: [{ key: "e1:t-top", branch: "feat/top", section: "active" }] }),
    ]);

    expect(groups).toEqual([]);
  });

  it("surfaces the stack number when gh reports one", () => {
    const [group] = buildStackGroups([source({ status: available(["feat/base", "feat/top"], 7) })]);

    expect(group?.stackNumber).toBe(7);
  });
});

describe("collectHiddenStackMemberKeys", () => {
  it("collects every masked member so callers can filter the visible list", () => {
    const groups = buildStackGroups([source({ collapsed: true })]);

    expect([...collectHiddenStackMemberKeys(groups)]).toEqual(["e1:t-base"]);
  });

  it("makes a collapsed group one keyboard step onto the checked-out layer", () => {
    const groups = buildStackGroups([source({ collapsed: true })]);
    const hidden = collectHiddenStackMemberKeys(groups);
    const traversable = ["e1:t-above", "e1:t-base", "e1:t-top", "e1:t-below"].filter(
      (key) => !hidden.has(key),
    );

    expect(
      resolveAdjacentThreadId({
        threadIds: traversable,
        currentThreadId: "e1:t-above",
        direction: "next",
      }),
    ).toBe("e1:t-top");
    expect(
      resolveAdjacentThreadId({
        threadIds: traversable,
        currentThreadId: "e1:t-below",
        direction: "previous",
      }),
    ).toBe("e1:t-top");
  });

  it("hides nothing while the group is expanded", () => {
    const groups = buildStackGroups([source({})]);

    expect([...collectHiddenStackMemberKeys(groups)]).toEqual([]);
  });
});

describe("insertStackGroupsIntoSidebarItems", () => {
  const items: readonly SidebarListItem[] = [
    { kind: "marker", marker: "pinned-header" },
    { kind: "marker", marker: "pinned-divider" },
    { kind: "marker", marker: "active-placeholder" },
    { kind: "thread", key: "e1:t-other", section: "active" },
    { kind: "thread", key: "e1:t-top", section: "active" },
    { kind: "thread", key: "e1:t-later", section: "active" },
    { kind: "thread", key: "e1:t-base", section: "active" },
    { kind: "marker", marker: "settled-header" },
  ];

  it("gathers members into one contiguous run behind a stack row", () => {
    const groups = buildStackGroups([source({})]);
    const next = insertStackGroupsIntoSidebarItems({ items, groups });

    expect(next.map((item) => (item.kind === "thread" ? item.key : item.kind))).toEqual([
      "marker",
      "marker",
      "marker",
      "e1:t-other",
      "stack",
      "e1:t-base",
      "e1:t-top",
      "e1:t-later",
      "marker",
    ]);
  });

  it("keeps each member's own section when the group spans two shelves", () => {
    // A settled layer renders attenuated with its badge inside the group; it
    // must not inherit the group's home section, or it renders as an active
    // card with the wrong variant action.
    const spanning: readonly SidebarListItem[] = [
      { kind: "marker", marker: "pinned-header" },
      { kind: "marker", marker: "pinned-divider" },
      { kind: "thread", key: "e1:t-top", section: "active" },
      { kind: "marker", marker: "settled-header" },
      { kind: "thread", key: "e1:t-base", section: "settled" },
    ];
    const groups = buildStackGroups([
      source({
        members: [
          { key: "e1:t-top", branch: "feat/top", section: "active" },
          { key: "e1:t-base", branch: "feat/base", section: "settled" },
        ],
      }),
    ]);
    const next = insertStackGroupsIntoSidebarItems({ items: spanning, groups });
    const sections = next.flatMap((item) =>
      item.kind === "thread" ? [[item.key, item.section]] : [],
    );

    expect(sections).toEqual([
      ["e1:t-base", "settled"],
      ["e1:t-top", "active"],
    ]);
  });

  it("omits masked members from the list entirely", () => {
    const groups = buildStackGroups([source({ collapsed: true })]);
    const next = insertStackGroupsIntoSidebarItems({ items, groups });

    expect(next.some((item) => item.kind === "thread" && item.key === "e1:t-base")).toBe(false);
    expect(next.some((item) => item.kind === "thread" && item.key === "e1:t-top")).toBe(true);
  });
});

describe("resolveStackDragRunKeys", () => {
  it("moves the whole run when the stack row is dragged", () => {
    const groups = buildStackGroups([source({})]);

    expect(resolveStackDragRunKeys({ groups, activeId: stackMarkerId("/repo/wt") })).toEqual([
      "e1:t-base",
      "e1:t-top",
    ]);
  });

  it("moves one thread when a layer row is dragged", () => {
    const groups = buildStackGroups([source({})]);

    expect(resolveStackDragRunKeys({ groups, activeId: "e1:t-top" })).toEqual(["e1:t-top"]);
  });
});
