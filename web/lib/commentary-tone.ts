// Shared color treatment for a live game's rule-based commentary kind
// (api/src/api/routers/board_commentary.py's `CommentaryKind`). Factored
// out of feed-ticket.tsx and board-game-row.tsx, which each declared an
// identical copy of this map -- both keep using it via this import so the
// two never drift again, and search-result-tables.tsx (Task 5) reuses it
// for the NL search conflict badge so the visual language for "sources
// disagree" stays consistent across the live board and search.
export const COMMENTARY_COLOR: Record<string, string> = {
  conflict: "text-pink-600 dark:text-pink-400",
  stale: "text-amber-600 dark:text-amber-500",
  run: "text-amber-600 dark:text-amber-500",
  leader: "text-muted-foreground",
};
