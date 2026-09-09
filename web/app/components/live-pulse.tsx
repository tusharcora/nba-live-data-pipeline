/**
 * Pulsing-dot "LIVE" indicator, extracted from `app/live/LiveBoard.tsx`'s
 * `GameStatusBadge` so any future live-state surface (per the v2 UI
 * rework's spec, "shared between the home board, /live, and anywhere
 * else a live state is shown") can reuse the exact same treatment
 * instead of re-implementing the ping animation.
 *
 * The dot is `aria-hidden` decoration; `label` (always visible text, not
 * a screen-reader-only affordance) is what actually conveys "live" --
 * this must never be the only thing that changes color, and the text
 * label already makes that a non-issue here. Callers are responsible for
 * their own `aria-live`/announcement behavior around this, same as
 * before (see `GameStatusBadge`'s own comment on why it doesn't
 * re-announce on every SSE tick).
 *
 * Not a `Badge` itself -- callers wrap this in whatever container variant
 * makes sense for their context (see `LiveBoard.tsx`'s
 * `GameStatusBadge`, which wraps it in a `Badge`).
 */
export function LivePulse({ label = "LIVE" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="relative flex size-1.5">
        <span className="absolute inline-flex size-full rounded-full bg-primary-foreground/70 motion-safe:animate-ping" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary-foreground" />
      </span>
      {label}
    </span>
  );
}

export default LivePulse;
