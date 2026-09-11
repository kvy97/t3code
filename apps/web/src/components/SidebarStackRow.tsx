import { memo, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { CSS } from "@dnd-kit/utilities";
import * as Schema from "effect/Schema";

import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  StackActionConflictedError,
  type ContextMenuItem,
  type StackActionKind,
} from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
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
  | `checkout:${string}`;

/** The row's right-click menu: the four whole-stack actions plus a checkout
    entry per layer, ordered bottom-to-top the way the layers render below
    the row. Disabled entirely while a member thread is running — the server
    guards the same condition, so this only prevents a click that would fail
    for a reason the user can already see (the running-thread dot). */
function buildStackRowMenuItems(input: {
  readonly layers: ReadonlyArray<{ readonly branch: string; readonly position: number }>;
  readonly busy: boolean;
}): ContextMenuItem<StackRowMenuId>[] {
  const items: ContextMenuItem<StackRowMenuId>[] = STACK_ROW_WHOLE_STACK_ACTIONS.map((entry) => ({
    id: entry.action,
    label: entry.label,
    disabled: input.busy,
  }));
  const layers = [...input.layers].sort((left, right) => left.position - right.position);
  layers.forEach((layer, index) => {
    items.push({
      id: `checkout:${layer.branch}`,
      label: `Check out ${layer.branch}`,
      disabled: input.busy,
      ...(index === 0 ? { separatorBefore: true } : {}),
    });
  });
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
      if (environmentId === null || group.unavailableReason !== null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const items = buildStackRowMenuItems({ layers, busy: props.busy });
        const clicked = await settlePromise(() =>
          api.contextMenu.show(items, { x: event.clientX, y: event.clientY }),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (clicked.value.startsWith("checkout:")) {
          void runStackAction("checkout", clicked.value.slice("checkout:".length));
          return;
        }
        void runStackAction(
          clicked.value as Extract<StackActionKind, "submit" | "sync" | "rebaseUpstack" | "merge">,
        );
      })();
    },
    [environmentId, group.unavailableReason, layers, props.busy, runStackAction],
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
