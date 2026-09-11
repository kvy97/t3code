import type { StackStatus, StackUnavailableReason } from "@t3tools/contracts";

import type { SidebarListItem, SidebarSection } from "./Sidebar.logic";

export const STACK_MARKER_PREFIX = "sidebar-stack-";

export function stackMarkerId(worktreePath: string): string {
  return `${STACK_MARKER_PREFIX}${worktreePath}`;
}

export interface StackGroupMember {
  readonly key: string;
  readonly branch: string | null;
  readonly section: SidebarSection;
}

export interface StackGroupSource {
  readonly worktreePath: string;
  /** Null while the chain loads: render the group, offer no stack action. */
  readonly status: StackStatus | null;
  readonly members: ReadonlyArray<StackGroupMember>;
  readonly collapsed: boolean;
  readonly checkedOutBranch: string | null;
  readonly routeKey: string | null;
}

export interface StackGroup {
  readonly worktreePath: string;
  readonly section: "pinned" | "active" | "settled";
  readonly memberKeys: readonly string[];
  readonly visibleMemberKeys: readonly string[];
  readonly hiddenMemberKeys: readonly string[];
  readonly layerCount: number;
  readonly stackNumber: number | null;
  readonly unavailableReason: StackUnavailableReason | null;
}

const SECTION_RANK: Record<"pinned" | "active" | "settled", number> = {
  pinned: 0,
  active: 1,
  settled: 2,
};

/**
 * Members diverge by construction: T3 settles a thread on its own when the
 * PR merges, so a live stack routinely holds settled layers. The group lands
 * in its most active member's section and only sinks into Settled once every
 * member is settled.
 */
function resolveGroupSection(
  members: ReadonlyArray<StackGroupMember>,
): "pinned" | "active" | "settled" {
  let best: "pinned" | "active" | "settled" = "settled";
  for (const member of members) {
    if (member.section === "snoozed") continue;
    const candidate = member.section;
    if (SECTION_RANK[candidate] < SECTION_RANK[best]) best = candidate;
  }
  return best;
}

/** Layer order comes from git and is not negotiable; a thread whose branch is
    no longer a layer keeps its incoming order at the top of the run. */
function orderMembers(
  members: ReadonlyArray<StackGroupMember>,
  status: StackStatus | null,
): StackGroupMember[] {
  if (status === null || status._tag !== "available") return [...members];
  const positionByBranch = new Map(
    status.layers.map((layer) => [layer.branch, layer.position] as const),
  );
  const matched: Array<{ member: StackGroupMember; position: number }> = [];
  const unmatched: StackGroupMember[] = [];
  for (const member of members) {
    const position = member.branch === null ? undefined : positionByBranch.get(member.branch);
    if (position === undefined) unmatched.push(member);
    else matched.push({ member, position });
  }
  matched.sort((left, right) => left.position - right.position);
  return [...matched.map((entry) => entry.member), ...unmatched];
}

/** Collapsed shows exactly one row, so keyboard traversal treats the group as
    one step and lands on the layer that is actually checked out. */
function resolveVisibleKeys(input: {
  readonly ordered: ReadonlyArray<StackGroupMember>;
  readonly collapsed: boolean;
  readonly checkedOutBranch: string | null;
  readonly routeKey: string | null;
}): readonly string[] {
  const keys = input.ordered.map((member) => member.key);
  if (!input.collapsed) return keys;
  const route = input.ordered.find((member) => member.key === input.routeKey);
  if (route !== undefined) return [route.key];
  const checkedOut = input.ordered.find(
    (member) => input.checkedOutBranch !== null && member.branch === input.checkedOutBranch,
  );
  const survivor = checkedOut ?? input.ordered[0];
  return survivor === undefined ? [] : [survivor.key];
}

export function buildStackGroups(sources: ReadonlyArray<StackGroupSource>): StackGroup[] {
  return sources.flatMap((source) => {
    // One thread is not a stack: grouping it would only add a chrome row.
    // Checked against the full member count, not the post-snoozed-filter
    // count — a snoozed layer still counts as a second thread on this
    // worktree, it just renders on its own shelf instead of in the group.
    if (source.members.length < 2) return [];
    const grouped = source.members.filter((member) => member.section !== "snoozed");
    if (grouped.length === 0) return [];
    const ordered = orderMembers(grouped, source.status);
    const visibleMemberKeys = resolveVisibleKeys({
      ordered,
      collapsed: source.collapsed,
      checkedOutBranch: source.checkedOutBranch,
      routeKey: source.routeKey,
    });
    const visible = new Set(visibleMemberKeys);
    return [
      {
        worktreePath: source.worktreePath,
        section: resolveGroupSection(ordered),
        memberKeys: ordered.map((member) => member.key),
        visibleMemberKeys,
        hiddenMemberKeys: ordered.map((member) => member.key).filter((key) => !visible.has(key)),
        layerCount: source.status?._tag === "available" ? source.status.layers.length : 0,
        stackNumber: source.status?._tag === "available" ? source.status.stackNumber : null,
        unavailableReason: source.status?._tag === "unavailable" ? source.status.reason : null,
      } satisfies StackGroup,
    ];
  });
}

export function collectHiddenStackMemberKeys(
  groups: ReadonlyArray<StackGroup>,
): ReadonlySet<string> {
  return new Set(groups.flatMap((group) => [...group.hiddenMemberKeys]));
}

/**
 * The sidebar list model stays flat. A group is a contiguous run of thread
 * keys behind one stack row, placed where its earliest member already sat, so
 * the drag/drop and section machinery keeps working unchanged.
 */
export function insertStackGroupsIntoSidebarItems(input: {
  readonly items: readonly SidebarListItem[];
  readonly groups: ReadonlyArray<StackGroup>;
}): SidebarListItem[] {
  if (input.groups.length === 0) return [...input.items];
  const groupByMemberKey = new Map<string, StackGroup>();
  for (const group of input.groups) {
    for (const key of group.memberKeys) groupByMemberKey.set(key, group);
  }
  // Each member keeps the section it already rendered in. T3 settles a layer
  // on its own when its PR merges, so a live group routinely spans the active
  // list and the settled shelf; a settled layer must stay attenuated with its
  // badge rather than inherit the group's home section and render as a card.
  const sectionByKey = new Map<string, SidebarSection>(
    input.items.flatMap((item) => (item.kind === "thread" ? [[item.key, item.section]] : [])),
  );
  const emitted = new Set<string>();
  const next: SidebarListItem[] = [];
  for (const item of input.items) {
    if (item.kind !== "thread") {
      next.push(item);
      continue;
    }
    const group = groupByMemberKey.get(item.key);
    if (group === undefined) {
      next.push(item);
      continue;
    }
    if (emitted.has(group.worktreePath)) continue;
    emitted.add(group.worktreePath);
    next.push({ kind: "stack", worktreePath: group.worktreePath });
    for (const key of group.visibleMemberKeys) {
      next.push({ kind: "thread", key, section: sectionByKey.get(key) ?? item.section });
    }
  }
  return next;
}

export function resolveStackDragRunKeys(input: {
  readonly groups: ReadonlyArray<StackGroup>;
  readonly activeId: string;
}): readonly string[] {
  if (input.activeId.startsWith(STACK_MARKER_PREFIX)) {
    const worktreePath = input.activeId.slice(STACK_MARKER_PREFIX.length);
    return input.groups.find((group) => group.worktreePath === worktreePath)?.memberKeys ?? [];
  }
  return [input.activeId];
}
