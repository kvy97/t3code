import { memo } from "react";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { CSS } from "@dnd-kit/utilities";

import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  describeStackUnavailable,
  formatStackLayerCountLabel,
  resolveStackRowLabel,
  type StackGroup,
} from "./Sidebar.stack.logic";
import type { SortableThreadRowBag } from "./Sidebar";

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

  return (
    <li data-thread-selection-safe className="list-none" {...sortableRootProps}>
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
      </button>
    </li>
  );
});

export default SidebarStackRow;
