import Link from "next/link";
import { ArrowRight, BarChart3, Radio } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const DESTINATIONS = [
  {
    href: "/live",
    icon: Radio,
    title: "Live Board",
    description:
      "Today's games, score and clock, pushed to the browser as they happen.",
    cta: "Open Live Board",
  },
  {
    href: "/quality",
    icon: BarChart3,
    title: "Data Quality Scorecard",
    description:
      "Schema-drift timeline, null-rate trends, and cross-source agreement — the pipeline watching itself.",
    cta: "Open Scorecard",
  },
] as const;

export default function Home() {
  return (
    <div className="relative isolate flex flex-1 flex-col overflow-hidden">
      {/* Decorative background glow — purely visual, clipped by the parent's overflow-hidden so it can never introduce scroll. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute -top-32 left-1/4 size-72 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute top-1/2 -right-24 size-80 rounded-full bg-primary/10 blur-3xl" />
      </div>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-4 py-16 sm:px-6 sm:py-24">
        <section className="flex flex-col items-start gap-5">
          <Badge variant="secondary" className="font-mono uppercase tracking-wide">
            Data engineering portfolio project
          </Badge>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Live Box Score Pipeline &amp; Data Quality Observatory
          </h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            An end-to-end NBA data pipeline where the portfolio-differentiating
            work is the ingestion, source reconciliation, and drift
            monitoring — not the dashboard on top of it. Two independent
            sources feed the same games through a Bronze/Silver/Gold
            warehouse, and every disagreement between them is logged, not
            silently resolved.
          </p>
        </section>

        <section
          aria-label="Explore the pipeline"
          className="grid grid-cols-1 gap-6 sm:grid-cols-2"
        >
          {DESTINATIONS.map(({ href, icon: Icon, title, description, cta }) => (
            <Card
              key={href}
              className="border border-border/60 bg-card/60 backdrop-blur-xl transition-all duration-200 hover:border-border hover:shadow-lg motion-safe:hover:-translate-y-0.5"
            >
              <CardHeader>
                <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon aria-hidden="true" className="size-5" />
                </div>
                <CardTitle className="text-lg">{title}</CardTitle>
                <CardDescription className="text-sm leading-6">
                  {description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  render={<Link href={href} />}
                  nativeButton={false}
                  className="w-full cursor-pointer sm:w-auto"
                >
                  {cta}
                  <ArrowRight
                    aria-hidden="true"
                    data-icon="inline-end"
                    className="size-4"
                  />
                </Button>
              </CardContent>
            </Card>
          ))}
        </section>

        <Separator />

        <footer className="text-sm text-muted-foreground">
          Built on Prefect, dbt, FastAPI, and Next.js — a medallion pipeline
          from raw pulls to a reconciled, drift-monitored warehouse.
        </footer>
      </main>
    </div>
  );
}
