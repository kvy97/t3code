import { memo, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { CSS } from "@dnd-kit/utilities";
import * as Schema from "effect/Schema";

import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  StackActionConflictedError,
  type ContextMenuItem,
  type ScopedThreadRef,
  type StackActionKind,
} from "@t3tools/contracts";

import { useThreadActions } from "../hooks/useThreadActions";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
} from "../state/entities";
import { stackEnvironment } from "../state/stack";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { describeStackActionResult } from "./CommandPalette.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  describeStackUnavailable,
  formatStackLayerCountLabel,
  resolveStackRowLabel,
  type StackGroup,
} from "./Sidebar.stack.logic";
import { dropVerbBadge, type SortableThreadRowBag } from "./Sidebar";
import type { SidebarDropVerb } from "./Sidebar.logic";

const STACK_ROW_WHOLE_STACK_ACTIONS: ReadonlyArray<{
  readonly action: Extract<StackActionKind, "submit" | "sync" | "rebaseUpstack" | "merge">;
  readonly label: string;
}> = [
  { action: "submit", label: "Submit stack" },
  { action: "sync", label: "Sync stack" },
  { action: "rebaseUpstack", label: "Rebase upstack" },
  { action: "merge", label: "Merge stack" },
];

type StackRowMenuId =
  | (typeof STACK_ROW_WHOLE_STACK_ACTIONS)[number]["action"]
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | `checkout:${string}`;

/**
 * The row's right-click menu: the four whole-stack `gh` actions plus a
 * checkout entry per layer (both gated on the stack backend being
 * available and disabled while a member is running, since the server would
 * refuse them anyway), and — regardless of stack-backend availability,
 * since these are plain thread-lifecycle commands — a pin/unpin and a
 * settle/unsettle toggle that apply to every member. Each toggle is hidden
 * entirely on a server that predates the capability, the same way
 * `SidebarThreadRow`'s own menu hides them, rather than offering an item
 * that fails on click.
 */
function buildStackRowMenuItems(input: {
  readonly stackAvailable: boolean;
  readonly layers: ReadonlyArray<{ readonly branch: string; readonly position: number }>;
  readonly busy: boolean;
  readonly pinningSupported: boolean;
  readonly settlementSupported: boolean;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
}): ContextMenuItem<StackRowMenuId>[] {
  const items: ContextMenuItem<StackRowMenuId>[] = [];

  if (input.stackAvailable) {
    items.push(
      ...STACK_ROW_WHOLE_STACK_ACTIONS.map((entry) => ({
        id: entry.action,
        label: entry.label,
        disabled: input.busy,
      })),
    );
  }

  const lifecycleItems: ContextMenuItem<StackRowMenuId>[] = [];
  if (input.pinningSupported) {
    lifecycleItems.push(
      input.isPinned ? { id: "unpin", label: "Unpin stack" } : { id: "pin", label: "Pin stack" },
    );
  }
  if (input.settlementSupported) {
    lifecycleItems.push(
      input.isSettled
        ? { id: "unsettle", label: "Un-settle stack" }
        : { id: "settle", label: "Settle stack" },
    );
  }
  lifecycleItems.forEach((item, index) => {
    items.push(index === 0 && items.length > 0 ? { ...item, separatorBefore: true } : item);
  });

  if (input.stackAvailable) {
    const layers = [...input.layers].sort((left, right) => left.position - right.position);
    layers.forEach((layer, index) => {
      items.push({
        id: `checkout:${layer.branch}`,
        label: `Check out ${layer.branch}`,
        disabled: input.busy,
        ...(index === 0 ? { separatorBefore: true } : {}),
      });
    });
  }

  return items;
}

const SidebarStackRow = memo(function SidebarStackRow(props: {
  group: StackGroup;
  bottomBranch: string | null;
  collapsed: boolean;
  /** True while any member thread has a running turn, whether that member is
      currently visible or hidden behind a collapse or the snoozed shelf. A
      static marker, never a spinner: users on high-refresh displays notice a
      repainting sidebar. */
  busy: boolean;
  onToggleCollapsed: (worktreePath: string) => void;
  /** What dropping the whole run where it currently hovers would do — same
      verb badge a plain thread row shows while it's the one being dragged. */
  dropVerb: SidebarDropVerb | null;
  /** Present when the server supports every drop outcome (mirrors
      SidebarThreadRow's own `sortable` prop): dnd-kit's sortable bag applied
      to the row root so the whole row drags. */
  sortable?: SortableThreadRowBag | undefined;
}) {
  const { group, sortable } = props;
  const label = resolveStackRowLabel({
    worktreePath: group.worktreePath,
    bottomBranch: props.bottomBranch,
  });
  const unavailable =
    group.unavailableReason === null ? null : describeStackUnavailable(group.unavailableReason);
  const Chevron = props.collapsed ? ChevronRight : ChevronDown;

  // Member keys are scoped thread keys ("<environmentId>:<threadId>"); the
  // bottom layer's environment is the worktree's environment, and — absent
  // any live "checked out branch" signal in this row — also the fallback
  // target for a conflict's terminal.
  const bottomMemberRef = parseScopedThreadKey(group.memberKeys[0] ?? "");
  const environmentId = bottomMemberRef?.environmentId ?? null;
  const memberThreadRefs = useMemo(
    () =>
      group.memberKeys.flatMap((key) => {
        const ref = parseScopedThreadKey(key);
        return ref ? [ref] : [];
      }),
    [group.memberKeys],
  );

  // `resolveGroupSection` already picks "pinned" the moment any member is
  // pinned, and "settled" only once every member is — the exact aggregate
  // the row's own pin/settle toggle needs, so this reuses that single
  // source rather than re-deriving it from the member threads.
  const isGroupPinned = group.section === "pinned";
  const isGroupSettled = group.section === "settled";

  const { pinThread, unpinThread, settleThread, unsettleThread } = useThreadActions();
  const runBulkThreadLifecycleAction = useCallback(
    async (
      action: (ref: ScopedThreadRef) => Promise<AtomCommandResult<unknown, unknown>>,
      successTitle: string,
      failureTitle: string,
    ) => {
      // Sequential, not Promise.all: pin's own orderKey defaults to "top of
      // the pinned run" computed fresh from local state, and running every
      // member's dispatch in parallel would have each read that same
      // pre-pin snapshot and collide on one key. Awaiting one at a time lets
      // each member's pin land before the next one computes its key.
      const results: AtomCommandResult<unknown, unknown>[] = [];
      for (const ref of memberThreadRefs) {
        results.push(await action(ref));
      }
      const failed = results.filter(
        (result): result is Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }> =>
          result._tag === "Failure" && !isAtomCommandInterrupted(result),
      );
      if (failed.length === 0) {
        toastManager.add(stackedThreadToast({ type: "success", title: successTitle }));
        return;
      }
      // A verb that half-applies must say so — never report the whole
      // group done when only some members actually changed.
      const error = squashAtomCommandFailure(failed[0]!);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title:
            failed.length === results.length
              ? failureTitle
              : `${failureTitle} (${failed.length} of ${results.length} layers)`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [memberThreadRefs],
  );

  const stackStatusQuery = useEnvironmentQuery(
    environmentId !== null && group.unavailableReason === null
      ? stackEnvironment.status({ environmentId, input: { worktreePath: group.worktreePath } })
      : null,
  );
  const layers = stackStatusQuery.data?._tag === "available" ? stackStatusQuery.data.layers : [];

  const runStackActionCommand = useAtomCommand(
    stackEnvironment.runAction,
    "sidebar-stack-row:run-action",
  );
  const runStackAction = useCallback(
    async (action: StackActionKind, branch?: string) => {
      if (environmentId === null) return;
      const result = await runStackActionCommand({
        environmentId,
        input: { worktreePath: group.worktreePath, action, ...(branch ? { branch } : {}) },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        // Conflict resolution stays out of the UI: point at the terminal for
        // the checked-out thread and let the user resolve it there.
        if (Schema.is(StackActionConflictedError)(error) && bottomMemberRef) {
          useTerminalUiStateStore
            .getState()
            .setTerminalOpen(
              scopeThreadRef(bottomMemberRef.environmentId, bottomMemberRef.threadId),
              true,
            );
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Stack action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: describeStackActionResult(result.value),
        }),
      );
    },
    [bottomMemberRef, environmentId, group.worktreePath, runStackActionCommand],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      if (environmentId === null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const items = buildStackRowMenuItems({
          stackAvailable: group.availability === "available",
          layers,
          busy: props.busy,
          pinningSupported: readEnvironmentSupportsPinning(environmentId),
          settlementSupported: readEnvironmentSupportsSettlement(environmentId),
          isPinned: isGroupPinned,
          isSettled: isGroupSettled,
        });
        if (items.length === 0) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(items, { x: event.clientX, y: event.clientY }),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (clicked.value === "pin" || clicked.value === "unpin") {
          const pin = clicked.value === "pin";
          void runBulkThreadLifecycleAction(
            (ref) => (pin ? pinThread(ref) : unpinThread(ref)),
            pin ? "Stack pinned" : "Stack unpinned",
            pin ? "Could not pin the stack" : "Could not unpin the stack",
          );
          return;
        }
        if (clicked.value === "settle" || clicked.value === "unsettle") {
          const settle = clicked.value === "settle";
          void runBulkThreadLifecycleAction(
            (ref) => (settle ? settleThread(ref) : unsettleThread(ref)),
            settle ? "Stack settled" : "Stack un-settled",
            settle ? "Could not settle the stack" : "Could not un-settle the stack",
          );
          return;
        }
        if (clicked.value.startsWith("checkout:")) {
          void runStackAction("checkout", clicked.value.slice("checkout:".length));
          return;
        }
        void runStackAction(
          clicked.value as Extract<StackActionKind, "submit" | "sync" | "rebaseUpstack" | "merge">,
        );
      })();
    },
    [
      environmentId,
      group.availability,
      isGroupPinned,
      isGroupSettled,
      layers,
      pinThread,
      props.busy,
      runBulkThreadLifecycleAction,
      runStackAction,
      settleThread,
      unpinThread,
      unsettleThread,
    ],
  );

  // Same dnd-kit wiring as SidebarThreadRow's `sortableRootProps`: the row
  // root carries the ref, translate transform, and pointer listeners so the
  // whole row is the drag handle (the pointer sensor's distance threshold
  // still lets a plain click through to the toggle button below).
  const sortableRootProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
        ...sortable.listeners,
      }
    : {};
  // Same overlay as SidebarThreadRow's `dragDestination`: only while this
  // row is the one actually lifted, so a hover elsewhere in the sidebar
  // never paints a verb on a row that isn't moving.
  const dragDestination =
    sortable?.isDragging && props.dropVerb !== null ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-[11px] font-medium text-primary"
      >
        {dropVerbBadge[props.dropVerb]}
      </span>
    ) : null;

  return (
    <li
      data-thread-selection-safe
      className="list-none"
      onContextMenu={handleContextMenu}
      {...sortableRootProps}
    >
      <button
        type="button"
        aria-expanded={!props.collapsed}
        onClick={() => props.onToggleCollapsed(group.worktreePath)}
        className={cn(
          "flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm select-none",
          "hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          sortable?.isDragging && "relative z-20",
        )}
      >
        <Chevron className="size-3.5 shrink-0 text-icon-muted" aria-hidden />
        <Layers className="size-3.5 shrink-0 text-icon-muted" aria-hidden />
        <span className="truncate font-medium">{label}</span>
        {group.stackNumber === null ? null : (
          <span className="shrink-0 text-xs text-muted-foreground">#{group.stackNumber}</span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatStackLayerCountLabel(group)}
        </span>
        {props.busy ? (
          <span
            aria-label="A thread in this worktree is running"
            className="size-1.5 shrink-0 rounded-full bg-sky-500 dark:bg-sky-400"
          />
        ) : null}
        {unavailable === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={<span className="shrink-0 text-xs text-muted-foreground">no stack</span>}
            />
            <TooltipPopup side="right">
              {unavailable.summary}
              {unavailable.remediation === null ? null : (
                <>
                  {" "}
                  <code>{unavailable.remediation}</code>
                </>
              )}
            </TooltipPopup>
          </Tooltip>
        )}
        {dragDestination}
      </button>
    </li>
  );
});

export default SidebarStackRow;
