"use client";

// Client component: recharts renders to SVG via browser refs/ResizeObserver,
// so it cannot run in the server component that owns `page.tsx` (see that
// file's header comment for the fetch/rendering split and why).
//
// Chart choices and colors were driven by three `ui-ux-pro-max` searches
// (cited in full in the PR body) run before any of this was written:
//   - "time series chart small data" (--domain chart) -> Line Chart for a
//     time-axis trend, "fewer than 4 points -> stat card" guidance
//     acknowledged but deliberately not followed as-is (see NullRateTrendChart
//     below), and "never distinguish series by hue alone" / "direct series
//     labels" accessibility notes.
//   - "dashboard KPI chart accessible" (--domain chart) -> Gauge/donut for a
//     single KPI against an implicit 0-100% range, with the note to place
//     the number as visible text beside the gauge rather than relying on
//     the arc alone.
//   - "chart color accessible" (--domain color) -> no direct match in the
//     product-palette-oriented color database (0 results; a broadened retry
//     also came up empty — see PR body). Applied the accessibility notes
//     surfaced by the two chart-domain results instead, plus this app's own
//     already-accessibility-audited `--chart-1..5` tokens from
//     `app/globals.css` (comment there documents the 4.5:1 contrast pass),
//     rather than introducing new unaudited hex values.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type HistoryPoint = { run_at: string; value: number };

export type PsiFieldSeries = {
  checkName: string;
  fieldLabel: string;
  points: HistoryPoint[];
};

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground)",
};

const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" };
const AXIS_LINE = { stroke: "var(--border)" };

function formatRunAt(runAt: string): string {
  const parsed = new Date(runAt);
  if (Number.isNaN(parsed.getTime())) return runAt;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Every chart below pairs its SVG (aria-hidden — recharts' generated markup
// has no meaningful per-point keyboard/AT access) with a visually-hidden
// (`sr-only`) summary + data table carrying the same values, per the "A11y
// Fallback" guidance returned by both chart-domain searches ("visible data
// table plus concise trend summary").

/**
 * Null-rate trend line. A time-series line chart per the "time series chart
 * small data" search result, with one deliberate deviation from its "<4
 * points -> use a stat card" guidance: this page already shows the latest
 * value as a stat card in the "Quality metrics" section above, so this chart
 * exists specifically to show the trend *shape* even at low volumes, which a
 * stat card can't. At exactly 1 point there is no trend to show — recharts
 * renders a single dot rather than a line segment (nothing to connect it
 * to), which is the correct, intentional rendering here, not a broken chart.
 */
export function NullRateTrendChart({
  checkName,
  points,
}: {
  checkName: string;
  points: HistoryPoint[];
}) {
  const data = points.map((p) => ({ ...p, label: formatRunAt(p.run_at) }));
  const latest = points[points.length - 1];
  const isSinglePoint = points.length === 1;
  const summary = isSinglePoint
    ? `${checkName}: a single recorded value, ${latest.value}, on ${latest.run_at}.`
    : `${checkName} trend across ${points.length} runs, from ${points[0].value} on ${points[0].run_at} to ${latest.value} on ${latest.run_at}.`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {isSinglePoint
          ? `Single value: ${latest.value}`
          : `Latest: ${latest.value} (${points.length} runs)`}
      </p>
      <div aria-hidden="true" className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              axisLine={AXIS_LINE}
              tickLine={false}
            />
            <YAxis tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} width={40} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelStyle={{ color: "var(--popover-foreground)" }}
              formatter={(value) => [String(value), checkName]}
            />
            <Line
              type="monotone"
              dataKey="value"
              name={checkName}
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={{ r: isSinglePoint ? 5 : 3, fill: "var(--chart-1)" }}
              activeDot={{ r: 6 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="sr-only">{summary}</p>
      <table className="sr-only">
        <caption>{`${checkName} history`}</caption>
        <thead>
          <tr>
            <th>Run at</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.run_at}>
              <td>{p.run_at}</td>
              <td>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * PSI-per-field small chart. Rendered as a horizontal bar of each field's
 * *latest* PSI value rather than a multi-series line of full history: PSI is
 * evaluated per-run per-field, so plotting several fields' full time series
 * on one small chart (per the task's "small" framing) would need several
 * distinct hues on top of each other, working against the "never distinguish
 * series by hue alone" note from the "time series chart small data" search.
 * A one-bar-per-field snapshot reads unambiguously at a glance and scales
 * cleanly from 1 field to many. Fields with no history yet are simply
 * omitted from the bars, rather than shown as zero (a missing check is not
 * the same as a confirmed-zero drift value).
 */
export function PsiPerFieldChart({ series }: { series: PsiFieldSeries[] }) {
  const data = series
    .filter((s) => s.points.length > 0)
    .map((s) => ({
      field: s.fieldLabel,
      value: s.points[s.points.length - 1].value,
      runAt: s.points[s.points.length - 1].run_at,
    }));

  const summary = `Latest PSI per field across ${data.length} field(s): ${data
    .map((d) => `${d.field} ${d.value}`)
    .join(", ")}.`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {data.length === 1
          ? `Single field: ${data[0].field} = ${data[0].value}`
          : `${data.length} fields tracked`}
      </p>
      <div aria-hidden="true" className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
            <XAxis type="number" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
            <YAxis
              type="category"
              dataKey="field"
              width={88}
              tick={AXIS_TICK}
              axisLine={AXIS_LINE}
              tickLine={false}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, _name, item) => [
                String(value),
                (item?.payload as { field?: string } | undefined)?.field ?? "PSI",
              ]}
            />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {data.map((entry, idx) => (
                <Cell key={entry.field} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="sr-only">{summary}</p>
      <table className="sr-only">
        <caption>Latest PSI value per field</caption>
        <thead>
          <tr>
            <th>Field</th>
            <th>Value</th>
            <th>Run at</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.field}>
              <td>{d.field}</td>
              <td>{d.value}</td>
              <td>{d.runAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Cross-source agreement rate gauge/donut, per the "dashboard KPI chart
 * accessible" search's Gauge/Bullet result: a single KPI against an implicit
 * 0-100% range renders as a gauge, with the percentage placed as visible
 * text (not color-coded) beside/within it, since the search's accessibility
 * note flags color-only KPI encodings as insufficient. A single point is the
 * normal, complete case for a gauge (it always shows one "latest" value) —
 * unlike the line chart above, there is no degraded 1-point rendering here.
 */
export function AgreementGaugeChart({
  checkName,
  points,
}: {
  checkName: string;
  points: HistoryPoint[];
}) {
  const latest = points[points.length - 1];
  const value = Math.max(0, Math.min(1, latest.value));
  const data = [
    { name: "Agreement", value },
    { name: "Remainder", value: 1 - value },
  ];
  const pct = `${(value * 100).toFixed(1)}%`;
  const summary = `${checkName}: latest cross-source agreement rate ${pct} as of ${latest.run_at}.`;

  return (
    <div className="flex flex-col items-center gap-2">
      <div aria-hidden="true" className="relative h-36 w-36">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="72%"
              outerRadius="100%"
              startAngle={90}
              endAngle={450}
              stroke="none"
              isAnimationActive={false}
            >
              <Cell fill="var(--chart-1)" />
              <Cell fill="var(--muted)" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
            {pct}
          </span>
          <span className="text-[10px] text-muted-foreground">agreement</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {points.length === 1
          ? "Single recorded value"
          : `${points.length} runs recorded`}{" "}
        · latest {latest.run_at}
      </p>
      <p className="sr-only">{summary}</p>
      <table className="sr-only">
        <caption>{`${checkName} history`}</caption>
        <thead>
          <tr>
            <th>Run at</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.run_at}>
              <td>{p.run_at}</td>
              <td>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
