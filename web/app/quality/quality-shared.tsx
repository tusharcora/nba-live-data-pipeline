import type { ReactNode } from "react";
import { ArrowRightLeft, Inbox, Minus, Plus } from "lucide-react";

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
  game_id?: string;
  field?: string;
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

// Conflict rows are a loosely-typed record (see `Conflict` above) — render
// the well-known fields as their own columns and fold anything else into a
// single JSON "details" column, rather than assuming a fixed shape.
export const CONFLICT_KNOWN_KEYS = new Set(["game_id", "field", "detected_at"]);

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
