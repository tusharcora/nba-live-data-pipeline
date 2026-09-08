"use client";

import { useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  ListTree,
  Loader2,
  Quote,
  Search,
  SearchX,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FOCUS_RING } from "@/lib/focus-ring";
import {
  readSearchStream,
  type SearchCitation,
} from "@/lib/search-stream";
import type { SearchResultData } from "@/lib/search-result-types";
import { cn } from "@/lib/utils";

import { SearchResultDataView } from "./search-result-tables";

const STREAM_ENDED_EARLY_MESSAGE =
  "The answer stream ended unexpectedly before finishing. Please try again.";
const TIMEOUT_MESSAGE =
  "The search took too long to respond. Please try again.";
/** No response/no `done` frame within this long counts as hung -- covers a
 * server that never replies at all (the common case, and the one this
 * timeout is tested against: aborting `fetch()`'s own signal before a
 * response arrives) as well as, in a real browser, a stream that opens but
 * then stalls forever (aborting an in-flight fetch's signal also cancels
 * its response body per the Fetch spec, which a hand-built `Response` in a
 * unit test doesn't reproduce). */
export const STREAM_TIMEOUT_MS = 45_000;

function connectionErrorMessage(status?: number): string {
  const statusNote = status !== undefined ? ` (server responded ${status})` : "";
  return `Couldn't reach the search service${statusNote}. Please try your question again.`;
}

/**
 * The four terminal states this page can land in per question, plus the
 * in-flight "streaming" state -- each rendered with its own visually
 * distinct treatment (SPEC.md CAP-5: "no data" and "ambiguous" must never
 * read as just different text in the same box as a normal answer).
 */
type SearchState =
  | { status: "idle" }
  | { status: "streaming"; text: string }
  | { status: "answer"; text: string; citation: SearchCitation | null; resultData: SearchResultData | null }
  | { status: "no-data" }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "error"; message: string };

/**
 * Search page UI (Story 3 of the NL-stats-search spec,
 * `_bmad-output/specs/spec-nl-stats-search/`). Calls Story 2's `/api/search`
 * BFF route directly with `fetch` rather than `EventSource` (used by
 * `/api/live`, see `app/live/LiveBoard.tsx`) because `EventSource` can't
 * send a POST body -- the SSE framing itself is parsed by
 * `readSearchStream` (`lib/search-stream.ts`), kept there so it's unit
 * tested without a DOM.
 *
 * Contract with `/api/search` (see `lib/search-stream.ts`'s header for the
 * full, confirmed shape): POST `{ question }`, an `event-stream` response
 * of anonymous `data:` text chunks terminated by either `event: done` /
 * JSON `data:` matching `{ citation, noData, candidates }` (the search
 * genuinely completed), or `event: error` / JSON `data:` matching
 * `{ message }` (the backend failed to run the search at all -- rendered
 * as its own distinct `error` state below, never folded into "no-data").
 */
export function SearchSection() {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight request on unmount so a late chunk never tries to
  // update state after the component is gone.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const isStreaming = state.status === "streaming";

  async function runSearch(submittedQuestion: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Distinguishes "aborted because a newer question superseded this one
    // (or the component unmounted)" -- silently bail, the newer run owns
    // the UI now -- from "aborted because it timed out," which still needs
    // to surface its own error state.
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, STREAM_TIMEOUT_MS);

    function supersededByNewerRequest(): boolean {
      return controller.signal.aborted && !timedOut;
    }

    setState({ status: "streaming", text: "" });

    try {
      let response: Response;
      try {
        response = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: submittedQuestion }),
          signal: controller.signal,
        });
      } catch {
        if (supersededByNewerRequest()) return;
        setState({
          status: "error",
          message: timedOut ? TIMEOUT_MESSAGE : connectionErrorMessage(),
        });
        return;
      }

      if (!response.ok || !response.body) {
        if (supersededByNewerRequest()) return;
        setState({
          status: "error",
          message: timedOut ? TIMEOUT_MESSAGE : connectionErrorMessage(response.status),
        });
        return;
      }

      let reachedDone = false;
      try {
        for await (const event of readSearchStream(response)) {
          if (supersededByNewerRequest()) return;

          switch (event.kind) {
            case "chunk":
              setState((prev) =>
                prev.status === "streaming"
                  ? { status: "streaming", text: prev.text + event.text }
                  : prev
              );
              break;

            case "done": {
              reachedDone = true;
              const { payload } = event;
              if (payload.noData) {
                setState({ status: "no-data" });
              } else if (payload.candidates && payload.candidates.length > 0) {
                setState({ status: "ambiguous", candidates: payload.candidates });
              } else {
                setState((prev) => ({
                  status: "answer",
                  text: prev.status === "streaming" ? prev.text : "",
                  citation: payload.citation,
                  resultData: payload.resultData,
                }));
              }
              break;
            }

            case "error":
              // Distinct from both the transport-level errors below (this
              // one came from the backend itself, mid-stream) and from
              // "no-data" (the search failed to run at all -- it never
              // produced a real, genuine, or ambiguous result to relay).
              // Reuses the same destructive `error` state/visual treatment
              // as a transport failure, since it's the same *kind* of
              // situation from the user's point of view: the search is
              // broken, not that there's no data. Returns directly (like
              // "done" above returns via readSearchStream ending the
              // generator) rather than falling through to the post-loop
              // "stream ended early" check.
              setState({ status: "error", message: event.payload.message });
              return;

            default: {
              // Exhaustiveness check: a new `SearchStreamEvent` kind that
              // isn't handled above fails to compile here.
              const exhaustiveCheck: never = event;
              return exhaustiveCheck;
            }
          }
        }
      } catch {
        if (supersededByNewerRequest()) return;
        setState({
          status: "error",
          message: timedOut ? TIMEOUT_MESSAGE : connectionErrorMessage(),
        });
        return;
      }

      if (!reachedDone) {
        if (supersededByNewerRequest()) return;
        setState({
          status: "error",
          message: timedOut ? TIMEOUT_MESSAGE : STREAM_ENDED_EARLY_MESSAGE,
        });
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || isStreaming) return;
    void runSearch(trimmed);
  }

  function askCandidate(candidate: string) {
    setQuestion(candidate);
    void runSearch(candidate);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-primary" />
            Ask a stats question
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <label htmlFor="search-question" className="sr-only">
                Ask a stats question
              </label>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="search-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. How many points did LeBron James score on Jan 5?"
                disabled={isStreaming}
                className="pl-8"
              />
            </div>
            <Button
              type="submit"
              disabled={isStreaming || question.trim().length === 0}
              className={cn("shrink-0", FOCUS_RING)}
            >
              {isStreaming ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Search aria-hidden="true" className="size-4" />
              )}
              Ask
            </Button>
          </form>
        </CardContent>
      </Card>

      <SearchResult state={state} onPickCandidate={askCandidate} />
    </div>
  );
}

function SearchResult({
  state,
  onPickCandidate,
}: {
  state: SearchState;
  onPickCandidate: (candidate: string) => void;
}) {
  switch (state.status) {
    case "idle":
      return null;

    case "streaming":
      return (
        <Card aria-live="polite" aria-busy="true">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              {state.text ? "Answering…" : "Thinking…"}
            </CardTitle>
          </CardHeader>
          {state.text ? (
            <CardContent>
              <p className="leading-6 whitespace-pre-wrap">
                {state.text}
                <span
                  aria-hidden="true"
                  className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary align-middle"
                />
              </p>
            </CardContent>
          ) : null}
        </Card>
      );

    case "answer":
      return (
        <Card aria-live="polite">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles aria-hidden="true" className="size-4 text-primary" />
              Answer
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {state.text ? (
              <p className="leading-6 whitespace-pre-wrap">{state.text}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                The assistant finished without returning any answer text.
              </p>
            )}
            <SearchResultDataView resultData={state.resultData} />
            {state.citation ? (
              <div className="flex items-start gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                <Quote aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Source: <span className="font-medium text-foreground">{state.citation.table}</span>{" "}
                  · {state.citation.dateRange}
                  {state.citation.gameCount !== undefined
                    ? ` · ${state.citation.gameCount} games`
                    : null}
                </span>
              </div>
            ) : (
              // CAP-4: every answer must state which table/date range it
              // came from. A `citation: null` alongside a real answer is a
              // sourcing gap, not a normal state -- rendering nothing here
              // would make an unsourced answer indistinguishable from a
              // sourced one. Kept in the "answer" branch (rather than a
              // separate top-level state) because the answer text itself
              // is still real content worth showing; only the missing
              // citation needs to be made visible, not the whole answer
              // hidden behind an error-style state.
              <div
                role="alert"
                className="flex items-start gap-2 border-t border-border pt-3 text-xs text-amber-600 dark:text-amber-500"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span>No source citation was returned for this answer.</span>
              </div>
            )}
          </CardContent>
        </Card>
      );

    case "error":
      return <SearchErrorAlert message={state.message} />;

    case "no-data":
      return (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center"
        >
          <SearchX aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No data for that</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Nothing in the pipeline&apos;s ingested data matches that question --
            it may fall outside the ingested date range, or name a player, team,
            or matchup this pipeline hasn&apos;t seen.
          </p>
        </div>
      );

    case "ambiguous":
      return (
        <Card aria-live="polite" className="ring-1 ring-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-primary">
              <ListTree aria-hidden="true" className="size-4" />
              Did you mean…
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              That name matches more than one close result -- pick one to ask again:
            </p>
            <ul className="flex flex-col gap-2">
              {state.candidates.map((candidate) => (
                <li key={candidate}>
                  <button
                    type="button"
                    onClick={() => onPickCandidate(candidate)}
                    className={cn(
                      "w-full cursor-pointer rounded-lg border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-primary/50 hover:bg-primary/5",
                      FOCUS_RING
                    )}
                  >
                    {candidate}
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      );

    default: {
      // Exhaustiveness check: a new `SearchState` variant that isn't
      // handled above fails to compile here rather than silently falling
      // through to whichever `case` happened to be listed last.
      const exhaustiveCheck: never = state;
      return exhaustiveCheck;
    }
  }
}

/** Rendered by `SearchSection` in an `error` state via `Alert`, matching the
 * `destructive` treatment already used by every other fetch-error banner in
 * this app (e.g. `explorer-section.tsx`'s `GAMES_FETCH_ERROR`). Exported
 * separately only so the error copies (connection, timeout, stream-ended)
 * still route through one visual treatment. */
export function SearchErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export default SearchSection;
