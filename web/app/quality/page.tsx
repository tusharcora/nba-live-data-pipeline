import { headers } from "next/headers";
import { Inbox, TriangleAlert } from "lucide-react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

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

// Calmer, deliberate per-section empty state — deliberately not a bare
// "no data" line. The icon is decorative only (aria-hidden); the message
// text is the sole carrier of meaning for screen reader users.
function EmptySectionState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
      <Inbox aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

export default async function QualityPage() {
  const result = await getQualityData();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-16 py-16">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Data Quality Scorecard
        </h1>

        {!result.ok && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Quality data is unavailable</AlertTitle>
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        )}

        {result.ok && (
          <>
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-medium text-black dark:text-zinc-50">
                Quality metrics
              </h2>
              {result.data.metrics.length === 0 ? (
                <EmptySectionState message="No quality metrics have been recorded yet. Checks will appear here once the quality gate runs." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 dark:border-zinc-800">
                        <th className="py-2 pr-4 font-medium text-zinc-600 dark:text-zinc-400">
                          Check
                        </th>
                        <th className="py-2 pr-4 font-medium text-zinc-600 dark:text-zinc-400">
                          Value
                        </th>
                        <th className="py-2 pr-4 font-medium text-zinc-600 dark:text-zinc-400">
                          Last ran
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.data.metrics.map((metric) => (
                        <tr
                          key={metric.check_name}
                          className="border-b border-zinc-100 dark:border-zinc-900"
                        >
                          <td className="py-2 pr-4 text-black dark:text-zinc-50">
                            {metric.check_name}
                          </td>
                          <td className="py-2 pr-4 text-black dark:text-zinc-50">
                            {formatValue(metric.value)}
                          </td>
                          <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                            {metric.run_at}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-medium text-black dark:text-zinc-50">
                Recent schema changes
              </h2>
              {result.data.schema_changes.length === 0 ? (
                <EmptySectionState message="No schema changes detected in the current window. This section will populate the moment drift is fingerprinted." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 dark:border-zinc-800">
                        <th className="py-2 pr-4 font-medium text-zinc-600 dark:text-zinc-400">
                          Field
                        </th>
                        <th className="py-2 pr-4 font-medium text-zinc-600 dark:text-zinc-400">
                          Change type
                        </th>
                        <th className="py-2 pr-4 font-medium text-zinc-600 dark:text-zinc-400">
                          Old type
                        </th>
                        <th className="py-2 pr-4 font-medium text-zinc-600 dark:text-zinc-400">
                          New type
                        </th>
                        <th className="py-2 pr-4 font-medium text-zinc-600 dark:text-zinc-400">
                          Detected at
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.data.schema_changes.map((change) => (
                        <tr
                          key={change.id}
                          className="border-b border-zinc-100 dark:border-zinc-900"
                        >
                          <td className="py-2 pr-4 text-black dark:text-zinc-50">
                            {change.field_name}
                          </td>
                          <td className="py-2 pr-4 text-black dark:text-zinc-50">
                            {change.change_type}
                          </td>
                          <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                            {change.old_type ?? "–"}
                          </td>
                          <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                            {change.new_type ?? "–"}
                          </td>
                          <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                            {change.detected_at}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-medium text-black dark:text-zinc-50">
                Source conflicts
              </h2>
              <p className="text-sm text-black dark:text-zinc-50">
                Total: {result.data.conflicts.total.toLocaleString()}
              </p>
              {result.data.conflicts.recent.length === 0 ? (
                <EmptySectionState message="No source conflicts recorded. Field-level disagreements between sources will be listed here as they're detected." />
              ) : (
                <ul className="flex flex-col gap-1 text-sm text-black dark:text-zinc-50">
                  {result.data.conflicts.recent.map((conflict, idx) => (
                    <li key={idx} className="border-b border-zinc-100 py-2 dark:border-zinc-900">
                      {JSON.stringify(conflict)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
