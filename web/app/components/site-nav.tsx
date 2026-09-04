"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, BarChart3, Radio, Search } from "lucide-react";

import { cn } from "@/lib/utils";

import { LastVisitedTracker } from "./last-visited-tracker";
import { ThemeToggle } from "./theme-toggle";

const NAV_LINKS = [
  { href: "/live", label: "Live Board", icon: Radio },
  { href: "/quality", label: "Data Quality Scorecard", icon: BarChart3 },
  { href: "/explorer", label: "Historical Explorer", icon: Search },
] as const;

export const FOCUS_RING =
  "outline-none border border-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/70 backdrop-blur-md supports-[backdrop-filter]:bg-background/50">
      <LastVisitedTracker />
      <nav
        aria-label="Primary"
        className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6"
      >
        <Link
          href="/"
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-base font-semibold tracking-tight text-foreground transition-colors duration-200 hover:text-primary",
            FOCUS_RING
          )}
        >
          <Activity aria-hidden="true" className="size-5 text-primary" />
          <span className="font-mono">Boxscore.gg</span>
        </Link>

        <ul className="flex flex-wrap items-center gap-1 sm:gap-2">
          {NAV_LINKS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground",
                    FOCUS_RING,
                    active && "bg-muted text-foreground"
                  )}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span>{label}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <ThemeToggle />
          </li>
        </ul>
      </nav>
    </header>
  );
}

export default SiteNav;
