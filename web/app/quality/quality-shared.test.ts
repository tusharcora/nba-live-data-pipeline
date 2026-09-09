import { describe, expect, it } from "vitest";

import { buildRecentCatches } from "@/app/quality/quality-shared";
import type { Conflict, SchemaChange } from "@/app/quality/quality-shared";

const ADDED: SchemaChange = {
  id: 1,
  source: "nba_stats",
  endpoint: "live_scoreboard",
  field_name: "possession_arrow",
  change_type: "added",
  old_type: null,
  new_type: "string",
  detected_at: "2026-01-01T00:00:00Z",
};

const REMOVED: SchemaChange = {
  id: 2,
  source: "balldontlie",
  endpoint: "games",
  field_name: "attendance",
  change_type: "removed",
  old_type: "integer",
  new_type: null,
  detected_at: "2026-01-03T00:00:00Z",
};

const TYPE_CHANGED: SchemaChange = {
  id: 3,
  source: "nba_stats",
  endpoint: "boxscore",
  field_name: "minutes",
  change_type: "type_changed",
  old_type: "string",
  new_type: "integer",
  detected_at: "2026-01-02T00:00:00Z",
};

const CONFLICT: Conflict = {
  id: 1,
  game_id: "22500123",
  field_name: "home_score",
  primary_source: "balldontlie",
  primary_value: "103",
  secondary_source: "nba_stats",
  secondary_value: "101",
  resolution: "103",
  detected_at: "2026-01-04T00:00:00Z",
};

describe("buildRecentCatches", () => {
  it("sorts all entries newest-first across both sources", () => {
    const result = buildRecentCatches([ADDED, REMOVED, TYPE_CHANGED], [CONFLICT]);
    expect(result.map((r) => r.detected_at)).toEqual([
      "2026-01-04T00:00:00Z",
      "2026-01-03T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ]);
  });

  it("marks a removed field as critical severity, added as info, type_changed as warning", () => {
    const result = buildRecentCatches([ADDED, REMOVED, TYPE_CHANGED], []);
    const bySeverity = Object.fromEntries(result.map((r) => [r.id, r.severity]));
    expect(bySeverity["schema-1"]).toBe("info");
    expect(bySeverity["schema-2"]).toBe("critical");
    expect(bySeverity["schema-3"]).toBe("warning");
  });

  it("builds conflict copy from primary_source, not resolution", () => {
    const result = buildRecentCatches([], [CONFLICT]);
    // resolution ("103") is the winning VALUE, not a source name -- the
    // copy must never say "resolved using 103".
    expect(result[0].message).toContain("resolved using balldontlie");
    expect(result[0].message).not.toContain("resolved using 103");
  });

  it("returns an empty array for no data", () => {
    expect(buildRecentCatches([], [])).toEqual([]);
  });
});
