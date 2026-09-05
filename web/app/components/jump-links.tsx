import Link from "next/link";

import { FOCUS_RING } from "@/lib/focus-ring";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/live", label: "Live" },
  { href: "/quality", label: "Quality" },
  { href: "/explorer", label: "Explorer" },
  { href: "/settings", label: "Settings" },
] as const;

export type PageHref = (typeof LINKS)[number]["href"];

/**
 * Clear (transparent-fill, bordered) buttons between the app's five pages
 * -- not a nav bar (not sticky/fixed, no persistent chrome), just a
 * lightweight way to get from one page to another now that there's no top
 * bar. Rendered at the top of every page. Each one hover-highlights amber;
 * `current` renders as a filled, non-interactive button instead of a link
 * so a page never links to itself.
 */
export function JumpLinks({ current }: { current: PageHref }) {
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-2 text-sm">
      {LINKS.map(({ href, label }) =>
        href === current ? (
          <span
            key={href}
            aria-current="page"
            className="rounded-md border border-border bg-muted px-3 py-1.5 font-medium text-foreground"
          >
            {label}
          </span>
        ) : (
          <Link
            key={href}
            href={href}
            className={cn(
              "rounded-md border border-transparent px-3 py-1.5 text-muted-foreground transition-colors hover:border-amber-500/40 hover:text-amber-500",
              FOCUS_RING
            )}
          >
            {label}
          </Link>
        )
      )}
    </nav>
  );
}

export default JumpLinks;
