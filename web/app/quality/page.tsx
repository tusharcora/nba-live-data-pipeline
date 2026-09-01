import { headers } from "next/headers";
import type { ReactNode } from "react";
import { ArrowRightLeft, Minus, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Response shape matches the real `GET /quality` FastAPI endpoint
// (Employee A2, `week3/api-serving-quality-endpoint`, see
// `api/src/api/routers/quality.py`'s module docstring) now that both that
// PR and the `/api/quality` BFF passthrough (Employee B1) are merged.
type QualityMetric = {
  check_name: string;
  value: number | string;
  run_at: string;
  metadata?: Record<string, unknown> | null;
};

type SchemaChange = {
  id: number;
  source: string;
  endpoint: string;
  field_name: string;
  change_type: string;
  old_type: string | null;
  new_type: string | null;
  detected_at: string;
};

type Conflict = {
  game_id?: string;
  field?: string;
  detected_at?: string;
  [key: string]: unknown;
};

type QualityResponse = {
  metrics: QualityMetric[];
  schema_changes: SchemaChange[];
  conflicts: {
    total: number;
    recent: Conflict[];
  };
};

async function getBaseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const protocol = h.get("x-forwarded-proto") ?? "http";
  return `${protocol}://${host}`;
}

async function getQualityData(): Promise<
  { ok: true; data: QualityResponse } | { ok: false; message: string }
> {
  let baseUrl: string;
  try {
    baseUrl = await getBaseUrl();
  } catch {
    return { ok: false, message: "Could not determine request origin." };
  }

  try {
    const res = await fetch(`${baseUrl}/api/quality`, { cache: "no-store" });
    if (!res.ok) {
      return {
        ok: false,
        message: `Quality data is unavailable right now (status ${res.status}).`,
      };
    }
    const data = (await res.json()) as QualityResponse;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      message: "Could not reach the quality data service. Please try again later.",
    };
  }
}

function formatValue(value: number | string): string {
  return typeof value === "number" ? value.toLocaleString() : value;
}

// Visual treatment per schema-change type: each pairs a distinct badge
// variant with a distinct icon so the change type is never conveyed by
// color alone. The badge's visible text is always the raw `change_type`
// string from the API — this only decides the icon/variant around it.
function schemaChangeBadgeVisual(changeType: string): {
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
const CONFLICT_KNOWN_KEYS = new Set(["game_id", "field", "detected_at"]);

function conflictDetails(conflict: Conflict): string | null {
  const rest = Object.fromEntries(
    Object.entries(conflict).filter(([key]) => !CONFLICT_KNOWN_KEYS.has(key))
  );
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
}

export default async function QualityPage() {
  const result = await getQualityData();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Data Quality Scorecard
        </h1>

        {!result.ok && (
          <p className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {result.message}
          </p>
        )}

        {result.ok && (
          <>
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-medium text-black dark:text-zinc-50">
                Quality metrics
              </h2>
              {result.data.metrics.length === 0 ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  No quality data yet.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {result.data.metrics.map((metric) => (
                    <Card key={metric.check_name} size="sm">
                      <CardHeader>
                        <p className="truncate text-xs font-medium text-muted-foreground">
                          {metric.check_name}
                        </p>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-1">
                        <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                          {formatValue(metric.value)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {metric.run_at}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-medium text-black dark:text-zinc-50">
                Recent schema changes
              </h2>
              {result.data.schema_changes.length === 0 ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  No quality data yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Field</TableHead>
                      <TableHead>Change type</TableHead>
                      <TableHead>Old type</TableHead>
                      <TableHead>New type</TableHead>
                      <TableHead>Detected at</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.data.schema_changes.map((change) => {
                      const { variant, icon } = schemaChangeBadgeVisual(
                        change.change_type
                      );
                      return (
                        <TableRow key={change.id}>
                          <TableCell className="font-mono text-foreground">
                            {change.field_name}
                          </TableCell>
                          <TableCell>
                            <Badge variant={variant}>
                              {icon}
                              {change.change_type}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-muted-foreground">
                            {change.old_type ?? "–"}
                          </TableCell>
                          <TableCell className="font-mono text-muted-foreground">
                            {change.new_type ?? "–"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {change.detected_at}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-medium text-black dark:text-zinc-50">
                Source conflicts
              </h2>
              <Card size="sm" className="w-fit min-w-40">
                <CardHeader>
                  <p className="text-xs font-medium text-muted-foreground">
                    Total conflicts
                  </p>
                </CardHeader>
                <CardContent>
                  <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                    {result.data.conflicts.total.toLocaleString()}
                  </p>
                </CardContent>
              </Card>

              {result.data.conflicts.recent.length === 0 ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  No quality data yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Game</TableHead>
                      <TableHead>Field</TableHead>
                      <TableHead>Detected at</TableHead>
                      <TableHead>Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.data.conflicts.recent.map((conflict, idx) => (
                      <TableRow key={conflict.game_id ?? idx}>
                        <TableCell className="font-mono text-foreground">
                          {conflict.game_id ?? "–"}
                        </TableCell>
                        <TableCell className="font-mono text-foreground">
                          {conflict.field ?? "–"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {conflict.detected_at ?? "–"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {conflictDetails(conflict) ?? "–"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
