"use client";

import { Fragment, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FOCUS_RING } from "@/lib/focus-ring";
import { cn } from "@/lib/utils";

import {
  conflictDetails,
  schemaChangeBadgeVisual,
  type Conflict,
  type SchemaChange,
} from "./quality-shared";

// Client-side sortable tables for the Quality Scorecard. The page itself
// (`page.tsx`) stays an async Server Component that fetches data server-side
// — these two components are the "use client" leaf boundary that holds the
// only interactive state (which column is sorted, in which direction) over
// the arrays the server component already fetched and passes down as props.
// No new network request is ever made here; sorting is a pure in-memory
// `Array.prototype.sort` over what's already on the page.
//
// `SortableSchemaChangesTable` additionally holds per-row expand/collapse
// state (`expandedChangeIds`, a `Set<number>` of change `id`s — same shape
// as `expandedGameIds` in `app/explorer/page.tsx`) for the row-detail feature
// below. ui-ux-pro-max ("expandable row detail" / "side by side comparison
// view", `--domain ux`) had no direct entries for either query in
// `ux-guidelines.csv`; the one relevant hit from broadening the search
// ("table row expansion" / "comparison table") was the Responsive/"Table
// Handling" guideline — tables can overflow on mobile; use horizontal
// scroll or a card layout rather than letting a wide table break the
// layout. Applied here by keeping the expanded diff detail *inside* the
// same `<Table>` (a full-width `colSpan` row, not a wide sibling element
// that would force its own scroll container) and by wrapping the diff
// old-type/new-type pair in a `flex-wrap` row so it reflows on narrow
// viewports instead of overflowing.


type SortDirection = "asc" | "desc";

type SortState<TColumn extends string> = {
  column: TColumn;
  direction: SortDirection;
} | null;

/** Null-safe, locale- and numeric-aware string comparison so values like
 * "10" sort after "9" rather than before it, and missing values (old_type
 * on an "added" row, etc.) sort consistently to one end rather than
 * throwing off `localeCompare`. */
function compareValues(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const normalizedA = a ?? "";
  const normalizedB = b ?? "";
  return normalizedA.localeCompare(normalizedB, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** Three-state cycle per header click: none -> ascending -> descending ->
 * none (back to the server's original order), matching the common
 * sortable-table convention of always leaving an escape hatch back to the
 * unsorted view rather than forcing asc/desc forever. */
function nextSortState<TColumn extends string>(
  current: SortState<TColumn>,
  column: TColumn
): SortState<TColumn> {
  if (!current || current.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

function SortIcon({ direction }: { direction: SortDirection | null }) {
  if (direction === "asc") {
    return <ArrowUp aria-hidden="true" className="size-3.5" />;
  }
  if (direction === "desc") {
    return <ArrowDown aria-hidden="true" className="size-3.5" />;
  }
  return (
    <ArrowUpDown aria-hidden="true" className="size-3.5 text-muted-foreground/50" />
  );
}

/** A sortable `<TableHead>`: a real `<button>` (not a bare clickable `<div>`)
 * so it's keyboard-operable (Enter/Space) and focusable by default, plus the
 * shared `FOCUS_RING` for a visible focus indicator, and `aria-sort` on the
 * cell itself so screen readers announce the current sort state. */
function SortableHead<TColumn extends string>({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: TColumn;
  sort: SortState<TColumn>;
  onSort: (column: TColumn) => void;
}) {
  const active = sort?.column === column;
  const direction: SortDirection | null = active ? sort.direction : null;
  const ariaSort: "ascending" | "descending" | "none" =
    direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none";

  return (
    <TableHead aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded-sm text-left font-medium text-foreground hover:text-primary",
          FOCUS_RING
        )}
      >
        {label}
        <SortIcon direction={direction} />
      </button>
    </TableHead>
  );
}

type SchemaChangeColumn =
  | "field_name"
  | "change_type"
  | "old_type"
  | "new_type"
  | "detected_at";

// Number of real `<TableHead>` columns in the schema-changes table (toggle +
// field + change type + old type + new type + detected at) — the expanded
// detail row spans all of them so its content sits flush under the row it
// belongs to, matching the ui-ux-pro-max "Table Handling" finding (see
// module docstring) that a wide detail block should stay inside the table's
// own horizontal-scroll container rather than escaping it.
const SCHEMA_CHANGE_COLUMN_COUNT = 6;

/** Full old-type/new-type diff for one schema change, revealed by the row's
 * expand toggle below. Reuses the same expand/collapse *mechanism* as
 * Explorer's `GameCard`/`BoxScoreSection` (toggle button + conditional
 * rendering of a detail block) — adapted to a table row rather than a card,
 * since this table already reuses `Table`/`TableRow` for its ten-plus rows
 * and a second, unrelated card-based expansion widget here would be the
 * "second mechanism" the task explicitly says not to invent. */
function SchemaChangeDetailCell({ change }: { change: SchemaChange }) {
  return (
    <TableCell colSpan={SCHEMA_CHANGE_COLUMN_COUNT} className="bg-muted/30 py-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
          <span className="rounded-md border border-border bg-background px-2 py-1 text-muted-foreground">
            {change.old_type ?? "(field did not exist)"}
          </span>
          <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="rounded-md border border-border bg-background px-2 py-1 text-foreground">
            {change.new_type ?? "(field removed)"}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs text-muted-foreground sm:grid-cols-4">
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">Source</dt>
            <dd>{change.source}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">Endpoint</dt>
            <dd className="font-mono">{change.endpoint}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">Field</dt>
            <dd className="font-mono">{change.field_name}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">Detected at</dt>
            <dd>{change.detected_at}</dd>
          </div>
        </dl>
      </div>
    </TableCell>
  );
}

export function SortableSchemaChangesTable({
  changes,
}: {
  changes: SchemaChange[];
}) {
  const [sort, setSort] = useState<SortState<SchemaChangeColumn>>(null);
  // Set of expanded schema-change `id`s — same "Set<number> of expanded ids"
  // shape as `expandedGameIds` in `app/explorer/page.tsx`.
  const [expandedChangeIds, setExpandedChangeIds] = useState<Set<number>>(
    () => new Set()
  );

  function handleSort(column: SchemaChangeColumn) {
    setSort((prev) => nextSortState(prev, column));
  }

  function toggleChange(id: number) {
    setExpandedChangeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const sortedChanges = useMemo(() => {
    if (!sort) return changes;
    const sorted = [...changes].sort((a, b) =>
      compareValues(a[sort.column], b[sort.column])
    );
    if (sort.direction === "desc") sorted.reverse();
    return sorted;
  }, [changes, sort]);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <span className="sr-only">Expand row</span>
          </TableHead>
          <SortableHead label="Field" column="field_name" sort={sort} onSort={handleSort} />
          <SortableHead
            label="Change type"
            column="change_type"
            sort={sort}
            onSort={handleSort}
          />
          <SortableHead label="Old type" column="old_type" sort={sort} onSort={handleSort} />
          <SortableHead label="New type" column="new_type" sort={sort} onSort={handleSort} />
          <SortableHead
            label="Detected at"
            column="detected_at"
            sort={sort}
            onSort={handleSort}
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedChanges.map((change) => {
          const { variant, icon } = schemaChangeBadgeVisual(change.change_type);
          const expanded = expandedChangeIds.has(change.id);
          const detailId = `schema-change-detail-${change.id}`;
          return (
            <Fragment key={change.id}>
              <TableRow>
                <TableCell>
                  <button
                    type="button"
                    onClick={() => toggleChange(change.id)}
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    aria-label={`${expanded ? "Hide" : "Show"} diff details for ${change.field_name}`}
                    className={cn(
                      "flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground",
                      FOCUS_RING
                    )}
                  >
                    {expanded ? (
                      <ChevronUp aria-hidden="true" className="size-4" />
                    ) : (
                      <ChevronDown aria-hidden="true" className="size-4" />
                    )}
                  </button>
                </TableCell>
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
              {expanded && (
                <TableRow id={detailId} className="hover:bg-transparent">
                  <SchemaChangeDetailCell change={change} />
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

type ConflictColumn = "game_id" | "field" | "detected_at";

export function SortableConflictsTable({ conflicts }: { conflicts: Conflict[] }) {
  const [sort, setSort] = useState<SortState<ConflictColumn>>(null);

  function handleSort(column: ConflictColumn) {
    setSort((prev) => nextSortState(prev, column));
  }

  const sortedConflicts = useMemo(() => {
    if (!sort) return conflicts;
    const sorted = [...conflicts].sort((a, b) =>
      compareValues(
        a[sort.column] as string | undefined,
        b[sort.column] as string | undefined
      )
    );
    if (sort.direction === "desc") sorted.reverse();
    return sorted;
  }, [conflicts, sort]);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHead label="Game" column="game_id" sort={sort} onSort={handleSort} />
          <SortableHead label="Field" column="field" sort={sort} onSort={handleSort} />
          <SortableHead
            label="Detected at"
            column="detected_at"
            sort={sort}
            onSort={handleSort}
          />
          <TableHead>Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedConflicts.map((conflict, idx) => (
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
  );
}
