import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Small KPI tile -- label, a large monospace tabular-numeric value, and
 * an optional caption -- extracted from two identical inline `Card`
 * blocks in `app/components/sections/quality-section.tsx` (the per-metric
 * grid and the "Total conflicts" card). Per the v2 UI rework's design
 * spec, this is the shared building block for any future headline number
 * (quality metrics, KPIs) rather than each call site re-typing the same
 * `Card`/`CardHeader`/`CardContent` markup.
 */
export function StatTile({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
          {value}
        </p>
        {caption ? <p className="text-xs text-muted-foreground">{caption}</p> : null}
      </CardContent>
    </Card>
  );
}

export default StatTile;
