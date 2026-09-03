import { headers } from "next/headers";
import { TriangleAlert } from "lucide-react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

import {
  AgreementGaugeChart,
  NullRateTrendChart,
  PsiPerFieldChart,
  type HistoryPoint,
  type PsiFieldSeries,
} from "./quality-charts";
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

// One fetch per charted `check_name` against the new `/api/quality-history`
// BFF route (mirrors the try/catch-to-result shape used for the main
// `/quality` fetch below). A failed
// or non-200 fetch here degrades to an empty `points` array rather than a
// page-level error: an individual chart's history is not critical the way
// the primary `/quality` fetch is, and an empty array already renders the
// calm `EmptySectionState` below -- the same state a check that has simply
// never run yet would produce. This is a deliberate simplification: a
// distinct "history fetch failed" state was considered and rejected as
// unnecessary complexity for a per-chart, non-critical fetch.
async function getHistory(baseUrl: string, checkName: string): Promise<HistoryPoint[]> {
  try {
    const res = await fetch(
      `${baseUrl}/api/quality-history?check_name=${encodeURIComponent(checkName)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { check_name: string; points: HistoryPoint[] };
    return data.points ?? [];
  } catch {
    return [];
  }
}

type QualityPageData = {
  quality: QualityResponse;
  nullRate: { checkName: string; points: HistoryPoint[] } | null;
  agreement: { checkName: string; points: HistoryPoint[] } | null;
  psiSeries: PsiFieldSeries[];
};

// Fetches `/quality` (server-side, via the existing BFF route) plus one
// `/quality/history` call per relevant `check_name` -- all three charts'
// data, gathered here rather than as separate client-side fetches.
//
// Server-fetch-per-chart (this approach) vs. a client component fetching its
// own chart data: this page already fetches everything server-side with no
// client-side data fetching anywhere else on it, so this keeps that
// convention and avoids a loading-spinner state for the charts on first
// paint. The tradeoff is that the history fetches happen after `/quality`
// resolves (chart check_names depend on its `metrics`), rather than in
// parallel with it, and the page can't refresh a single chart without a full
// navigation. Both are acceptable for a scorecard page that's already
// `cache: "no-store"` end to end. recharts itself still requires a client
// component for the actual chart markup (browser refs/ResizeObserver) --
// see `quality-charts.tsx` -- so this function only fetches and shapes data;
// the three chart components render it.
//
// `check_name`s to chart are derived from `/quality`'s already-fetched
// `metrics` (the latest row per check) rather than a hardcoded list: if a
// check appears there at all, at least one row exists for it, so its
// history call is guaranteed non-empty. The only way a chart legitimately
// shows its 0-point empty state is when no matching check has ever run --
// which is this project's actual current state (see PR body).
async function loadQualityPageData(): Promise<
  { ok: true; data: QualityPageData } | { ok: false; message: string }
> {
  let baseUrl: string;
  try {
    baseUrl = await getBaseUrl();
  } catch {
    return { ok: false, message: "Could not determine request origin." };
  }

  let quality: QualityResponse;
  try {
    const res = await fetch(`${baseUrl}/api/quality`, { cache: "no-store" });
    if (!res.ok) {
      return {
        ok: false,
        message: `Quality data is unavailable right now (status ${res.status}).`,
      };
    }
    quality = (await res.json()) as QualityResponse;
  } catch {
    return {
      ok: false,
      message: "Could not reach the quality data service. Please try again later.",
    };
  }

  const nullRateCheckName = quality.metrics.find((m) =>
    m.check_name.startsWith("null_rate")
  )?.check_name;
  const agreementCheckName = quality.metrics.find((m) =>
    m.check_name.includes("agreement")
  )?.check_name;
  const psiCheckNames = quality.metrics
    .map((m) => m.check_name)
    .filter((name) => name.startsWith("psi_"))
    .sort();

  const [nullRatePoints, agreementPoints, psiPointsList] = await Promise.all([
    nullRateCheckName ? getHistory(baseUrl, nullRateCheckName) : Promise.resolve([]),
    agreementCheckName ? getHistory(baseUrl, agreementCheckName) : Promise.resolve([]),
    Promise.all(psiCheckNames.map((name) => getHistory(baseUrl, name))),
  ]);

  return {
    ok: true,
    data: {
      quality,
      nullRate: nullRateCheckName
        ? { checkName: nullRateCheckName, points: nullRatePoints }
        : null,
      agreement: agreementCheckName
        ? { checkName: agreementCheckName, points: agreementPoints }
        : null,
      psiSeries: psiCheckNames.map((name, i) => ({
        checkName: name,
        fieldLabel: name.replace(/^psi_/, ""),
        points: psiPointsList[i],
      })),
    },
  };
}

export default async function QualityPage() {
  const result = await loadQualityPageData();

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
              {result.data.quality.metrics.length === 0 ? (
                <EmptySectionState message="No quality metrics have been recorded yet. Checks will appear here once the quality gate runs." />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {result.data.quality.metrics.map((metric) => (
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
                Quality trends
              </h2>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Card size="sm">
                  <CardHeader>
                    <p className="text-xs font-medium text-muted-foreground">
                      Null rate trend
                    </p>
                  </CardHeader>
                  <CardContent>
                    {result.data.nullRate && result.data.nullRate.points.length > 0 ? (
                      <NullRateTrendChart
                        checkName={result.data.nullRate.checkName}
                        points={result.data.nullRate.points}
                      />
                    ) : (
                      <EmptySectionState message="No null-rate checks have run yet. This trend line appears once the quality gate records its first null_rate_* value." />
                    )}
                  </CardContent>
                </Card>

                <Card size="sm">
                  <CardHeader>
                    <p className="text-xs font-medium text-muted-foreground">
                      PSI per field
                    </p>
                  </CardHeader>
                  <CardContent>
                    {result.data.psiSeries.some((s) => s.points.length > 0) ? (
                      <PsiPerFieldChart series={result.data.psiSeries} />
                    ) : (
                      <EmptySectionState message="No PSI drift checks have run yet. This chart appears once psi_* checks record their first values." />
                    )}
                  </CardContent>
                </Card>

                <Card size="sm">
                  <CardHeader>
                    <p className="text-xs font-medium text-muted-foreground">
                      Cross-source agreement
                    </p>
                  </CardHeader>
                  <CardContent>
                    {result.data.agreement && result.data.agreement.points.length > 0 ? (
                      <AgreementGaugeChart
                        checkName={result.data.agreement.checkName}
                        points={result.data.agreement.points}
                      />
                    ) : (
                      <EmptySectionState message="No cross-source agreement checks have run yet. This gauge appears once reconciliation records its first value." />
                    )}
                  </CardContent>
                </Card>
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-medium text-foreground">
                Recent schema changes
              </h2>
              {result.data.quality.schema_changes.length === 0 ? (
                <EmptySectionState message="No schema changes detected in the current window. This section will populate the moment drift is fingerprinted." />
              ) : (
                <SortableSchemaChangesTable changes={result.data.quality.schema_changes} />
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
                    {result.data.quality.conflicts.total.toLocaleString()}
                  </p>
                </CardContent>
              </Card>

              {result.data.quality.conflicts.recent.length === 0 ? (
                <EmptySectionState message="No source conflicts recorded. Field-level disagreements between sources will be listed here as they're detected." />
              ) : (
                <SortableConflictsTable conflicts={result.data.quality.conflicts.recent} />
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
