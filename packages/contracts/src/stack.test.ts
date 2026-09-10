import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  StackActionInput,
  StackStatus,
  stackActionRewritesBranches,
  type StackStatus as StackStatusType,
} from "./stack.ts";

const encodeStatus = Schema.encodeUnknownSync(StackStatus);
const decodeStatus = Schema.decodeUnknownSync(StackStatus);
const decodeActionInput = Schema.decodeUnknownSync(StackActionInput);

const FRESHNESS = {
  source: "live-local" as const,
  observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
  expiresAt: Option.none<DateTime.Utc>(),
};

/** Round-trip: the Type value the server builds must survive the wire. */
const roundTrip = (status: StackStatusType) => decodeStatus(encodeStatus(status));

describe("StackStatus", () => {
  it("round-trips an available stack bottom-to-top", () => {
    const status = roundTrip({
      _tag: "available",
      worktreePath: "/repo/wt",
      trunk: "main",
      stackNumber: null,
      layers: [
        { branch: "feat/base", position: 0 },
        { branch: "feat/top", position: 1 },
      ],
      freshness: FRESHNESS,
    });

    expect(status._tag).toBe("available");
    if (status._tag !== "available") return;
    expect(status.layers.map((layer) => layer.branch)).toEqual(["feat/base", "feat/top"]);
    expect(status.stackNumber).toBeNull();
  });

  it("round-trips an unavailable stack without inventing a layer list", () => {
    const status = roundTrip({
      _tag: "unavailable",
      reason: "extension-missing",
      freshness: FRESHNESS,
    });

    expect(status._tag).toBe("unavailable");
    if (status._tag !== "unavailable") return;
    expect(status.reason).toBe("extension-missing");
    expect(status).not.toHaveProperty("layers");
  });

  it("rejects an unknown unavailability reason", () => {
    const valid = encodeStatus({
      _tag: "unavailable",
      reason: "extension-missing",
      freshness: FRESHNESS,
    }) as Record<string, unknown>;

    expect(() => decodeStatus({ ...valid, reason: "nope" })).toThrow();
  });
});

describe("StackActionInput", () => {
  it("keeps branch optional for whole-stack actions", () => {
    const input = decodeActionInput({ worktreePath: "/repo/wt", action: "submit" });

    expect(input.branch).toBeUndefined();
  });
});

describe("stackActionRewritesBranches", () => {
  it("is true only for the actions that rewrite local history", () => {
    expect(stackActionRewritesBranches("sync")).toBe(true);
    expect(stackActionRewritesBranches("rebaseUpstack")).toBe(true);
    expect(stackActionRewritesBranches("submit")).toBe(false);
    expect(stackActionRewritesBranches("merge")).toBe(false);
    expect(stackActionRewritesBranches("checkout")).toBe(false);
    expect(stackActionRewritesBranches("addLayer")).toBe(false);
  });
});
