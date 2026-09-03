import { headers } from "next/headers";
import { TriangleAlert } from "lucide-react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

import {
  EmptySectionState,
  formatValue,
  type QualityResponse,
} from "./quality-shared";
import { SortableConflictsTable, SortableSchemaChangesTable } from "./quality-tables";

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

export default async function QualityPage() {
  const result = await getQualityData();

  return (
    <div className="flex flex-1 flex-col font-sans">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
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
              <h2 className="text-lg font-medium text-foreground">
                Quality metrics
              </h2>
              {result.data.metrics.length === 0 ? (
                <EmptySectionState message="No quality metrics have been recorded yet. Checks will appear here once the quality gate runs." />
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
              <h2 className="text-lg font-medium text-foreground">
                Recent schema changes
              </h2>
              {result.data.schema_changes.length === 0 ? (
                <EmptySectionState message="No schema changes detected in the current window. This section will populate the moment drift is fingerprinted." />
              ) : (
                <SortableSchemaChangesTable changes={result.data.schema_changes} />
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-medium text-foreground">
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
                <EmptySectionState message="No source conflicts recorded. Field-level disagreements between sources will be listed here as they're detected." />
              ) : (
                <SortableConflictsTable conflicts={result.data.conflicts.recent} />
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
