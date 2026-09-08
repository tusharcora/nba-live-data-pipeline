"use client";

import { useEffect, useState } from "react";
import { Newspaper } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FOCUS_RING } from "@/lib/focus-ring";
import { cn } from "@/lib/utils";

// Response shape matches `GET /news` (`api/src/api/routers/news.py`) as
// forwarded verbatim by `app/api/news/route.ts`.
type NewsArticle = {
  article_id: number;
  headline: string;
  summary: string | null;
  byline: string | null;
  published_at: string;
  article_url: string;
};

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; articles: NewsArticle[] };

const FETCH_ERROR_MESSAGE = "Couldn't reach the news service. Please try again.";

/** "2026-09-06T18:30:00Z" -> "Sep 6, 2026" -- same locale-formatting
 * approach as `formatGameDate` elsewhere in this app. */
function formatPublishedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function NewsSection() {
  const [reporter, setReporter] = useState("");
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    // Deferred into a resolved-microtask `.then()` rather than called
    // synchronously in the effect body -- same shape as the localStorage
    // read effect in `explorer-section.tsx`, to satisfy this repo's
    // `react-hooks/set-state-in-effect` lint rule (this effect re-runs on
    // every `reporter` change, so -- unlike a mount-only effect -- it can't
    // rely solely on the `useState` initializer for the "loading" state).
    Promise.resolve().then(() => {
      if (!cancelled) setState({ status: "loading" });
    });

    const params = new URLSearchParams();
    if (reporter.trim()) params.set("reporter", reporter.trim());
    const query = params.toString();

    fetch(`/api/news${query ? `?${query}` : ""}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`/api/news responded ${res.status}`);
        }
        return res.json();
      })
      .then((data: ApiList<NewsArticle> | null) => {
        if (!cancelled) setState({ status: "loaded", articles: data?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [reporter]);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Newspaper className="size-5" aria-hidden="true" />
          NBA News
        </h2>
        <Input
          value={reporter}
          onChange={(e) => setReporter(e.target.value)}
          placeholder="Filter by reporter (e.g. Charania)"
          className={cn("max-w-xs", FOCUS_RING)}
          aria-label="Filter news by reporter"
        />
      </div>

      {state.status === "loading" && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {state.status === "error" && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load news</AlertTitle>
          <AlertDescription>{FETCH_ERROR_MESSAGE}</AlertDescription>
        </Alert>
      )}

      {state.status === "loaded" && state.articles.length === 0 && (
        <Alert>
          <AlertTitle>No articles found</AlertTitle>
          <AlertDescription>
            {reporter.trim()
              ? `No recent articles matched "${reporter.trim()}".`
              : "No recent NBA news available right now."}
          </AlertDescription>
        </Alert>
      )}

      {state.status === "loaded" &&
        state.articles.map((article) => (
          <Card key={article.article_id}>
            <CardHeader>
              <CardTitle className="text-base">
                <a
                  href={article.article_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn("hover:underline", FOCUS_RING)}
                >
                  {article.headline}
                </a>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
              {article.summary && <p>{article.summary}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {article.byline && <Badge variant="outline">{article.byline}</Badge>}
                <span>{formatPublishedDate(article.published_at)}</span>
              </div>
            </CardContent>
          </Card>
        ))}
    </section>
  );
}

export default NewsSection;
