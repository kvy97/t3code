import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { vcsCommandScheduler } from "./vcsCommandScheduler.ts";

/**
 * Sidebar rows keep the last chain they rendered, so a short grace period
 * covers virtualization releasing and re-leasing the subscription during a
 * scroll — same reasoning as the VCS status TTL next door.
 */
const STACK_STATUS_IDLE_TTL_MS = 10_000;

export function createStackEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // `stack.view` emits a complete `StackStatus` per event (snapshot, then
    // deduplicated updates from the server), so this is a plain relay: no
    // fold/accumulator like the VCS status stream needs.
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:stack:status",
      tag: WS_METHODS.stackView,
      idleTtlMs: STACK_STATUS_IDLE_TTL_MS,
    }),
    runAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:stack:run-action",
      tag: WS_METHODS.stackAction,
      scheduler: vcsCommandScheduler,
      // Same scheduler and key shape as the VCS commands' per-worktree serial
      // lane, so a stack action and a plain git mutation on the same
      // worktree never race each other client-side.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.worktreePath]),
      },
    }),
  };
}
