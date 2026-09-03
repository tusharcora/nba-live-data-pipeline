"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FOCUS_RING } from "@/app/components/site-nav";
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

export function SortableSchemaChangesTable({
  changes,
}: {
  changes: SchemaChange[];
}) {
  const [sort, setSort] = useState<SortState<SchemaChangeColumn>>(null);

  function handleSort(column: SchemaChangeColumn) {
    setSort((prev) => nextSortState(prev, column));
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
