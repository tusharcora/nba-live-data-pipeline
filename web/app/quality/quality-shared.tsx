import type { ReactNode } from "react";
import { ArrowRightLeft, Inbox, Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

// Response shape matches the real `GET /quality` FastAPI endpoint
// (Employee A2, `week3/api-serving-quality-endpoint`, see
// `api/src/api/routers/quality.py`'s module docstring) now that both that
// PR and the `/api/quality` BFF passthrough (Employee B1) are merged.
//
// Types and shared render helpers live here (rather than in `page.tsx`)
// so that both the server-component page and the client-only sortable
// table components (`quality-tables.tsx`) can import them without the
// client bundle ever pulling in `page.tsx`'s `next/headers` import — a
// "use client" file cannot safely import a *value* from a module that
// itself imports server-only APIs.
export type QualityMetric = {
  check_name: string;
  value: number | string;
  run_at: string;
  metadata?: Record<string, unknown> | null;
};

export type SchemaChange = {
  id: number;
  source: string;
  endpoint: string;
  field_name: string;
  change_type: string;
  old_type: string | null;
  new_type: string | null;
  detected_at: string;
};

export type Conflict = {
  id?: number;
  game_id?: string;
  field_name?: string;
  primary_source?: string;
  primary_value?: string | null;
  secondary_source?: string;
  secondary_value?: string | null;
  resolution?: string;
  detected_at?: string;
  [key: string]: unknown;
};

export type QualityResponse = {
  metrics: QualityMetric[];
  schema_changes: SchemaChange[];
  conflicts: {
    total: number;
    recent: Conflict[];
  };
};

export function formatValue(value: number | string): string {
  return typeof value === "number" ? value.toLocaleString() : value;
}

// Visual treatment per schema-change type: each pairs a distinct badge
// variant with a distinct icon so the change type is never conveyed by
// color alone. The badge's visible text is always the raw `change_type`
// string from the API — this only decides the icon/variant around it.
export function schemaChangeBadgeVisual(changeType: string): {
  variant: "secondary" | "destructive" | "outline";
  icon: ReactNode;
} {
  switch (changeType) {
    case "added":
      return { variant: "secondary", icon: <Plus /> };
    case "removed":
      return { variant: "destructive", icon: <Minus /> };
    case "type_changed":
      return { variant: "outline", icon: <ArrowRightLeft /> };
    default:
      return { variant: "outline", icon: <ArrowRightLeft /> };
  }
}

export type RecentCatch = {
  id: string;
  detected_at: string;
  message: string;
  severity: "info" | "warning" | "critical";
};

function schemaChangeCatchMessage(change: SchemaChange): string {
  switch (change.change_type) {
    case "added":
      return `${change.source} added a new field ("${change.field_name}") to its ${change.endpoint} feed — no action needed.`;
    case "removed":
      return `${change.source} removed the field "${change.field_name}" from its ${change.endpoint} feed — this can break downstream parsing if anything still expects it.`;
    case "type_changed":
      return `${change.source} changed the type of "${change.field_name}" in its ${change.endpoint} feed (${change.old_type ?? "unknown"} → ${change.new_type ?? "unknown"}).`;
    default:
      return `${change.source} changed "${change.field_name}" in its ${change.endpoint} feed.`;
  }
}

function schemaChangeSeverity(changeType: string): RecentCatch["severity"] {
  if (changeType === "removed") return "critical";
  if (changeType === "type_changed") return "warning";
  return "info";
}

function conflictCatchMessage(conflict: Conflict): string {
  const game = conflict.game_id ?? "a game";
  const field = (conflict.field_name ?? "a field").replace(/_/g, " ");
  const primary = conflict.primary_source ?? "the primary source";
  const secondary = conflict.secondary_source ?? "a secondary source";
  // Built from primary_source, never `resolution` -- resolution holds the
  // winning VALUE, not a source name (quality/reconciliation.py).
  return `Detected a ${field} disagreement between ${primary} and ${secondary} on game ${game} — resolved using ${primary}.`;
}

/** Merges schema-change and conflict events into one reverse-chronological
 * feed for the Trust Center's headline "what have we caught" view --
 * both inputs already come from the same `GET /quality` response
 * (`schema_changes`, `conflicts.recent`); this is a pure frontend merge,
 * no new API call. */
export function buildRecentCatches(
  schemaChanges: SchemaChange[],
  conflicts: Conflict[]
): RecentCatch[] {
  const schemaCatches: RecentCatch[] = schemaChanges.map((change) => ({
    id: `schema-${change.id}`,
    detected_at: change.detected_at,
    message: schemaChangeCatchMessage(change),
    severity: schemaChangeSeverity(change.change_type),
  }));
  const conflictCatches: RecentCatch[] = conflicts.map((conflict, idx) => ({
    id: `conflict-${conflict.id ?? idx}`,
    detected_at: conflict.detected_at ?? "",
    message: conflictCatchMessage(conflict),
    severity: "warning",
  }));
  return [...schemaCatches, ...conflictCatches].sort((a, b) =>
    b.detected_at.localeCompare(a.detected_at)
  );
}

const SEVERITY_DOT: Record<RecentCatch["severity"], string> = {
  info: "bg-muted-foreground",
  warning: "bg-amber-500",
  critical: "bg-destructive",
};

export function RecentCatchesFeed({ catches }: { catches: RecentCatch[] }) {
  if (catches.length === 0) {
    return (
      <EmptySectionState message="No schema changes or source disagreements caught yet. This feed fills in as the pipeline runs." />
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {catches.slice(0, 10).map((item) => (
        <li
          key={item.id}
          className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <span
            aria-hidden="true"
            className={cn("mt-1 size-2 shrink-0 rounded-full", SEVERITY_DOT[item.severity])}
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm text-foreground">{item.message}</p>
            <p className="text-xs text-muted-foreground">{item.detected_at}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

// Conflict rows are a loosely-typed record (see `Conflict` above) — render
// the well-known fields as their own columns and fold anything else into a
// single JSON "details" column, rather than assuming a fixed shape.
export const CONFLICT_KNOWN_KEYS = new Set(["game_id", "field_name", "detected_at"]);

export function conflictDetails(conflict: Conflict): string | null {
  const rest = Object.fromEntries(
    Object.entries(conflict).filter(([key]) => !CONFLICT_KNOWN_KEYS.has(key))
  );
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
}

// Calmer, deliberate per-section empty state — deliberately not a bare
// "no data" line. The icon is decorative only (aria-hidden); the message
// text is the sole carrier of meaning for screen reader users.
export function EmptySectionState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
      <Inbox aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
