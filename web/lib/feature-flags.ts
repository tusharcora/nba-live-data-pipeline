// Feature flags gated behind env vars -- deliberately not a UI toggle or a
// database row, so enabling one is always an explicit, auditable deploy-time
// decision (setting an env var and redeploying), never something that ships
// silently as part of a code merge.

/**
 * Gates the bettor-trust pitch copy (the homepage hero, the Trust Center's
 * subtitle in `web/app/components/sections/quality-section.tsx`) that claims
 * real-time source-disagreement detection is live and proven.
 *
 * Defaults to `false` (the safe copy) -- as of this flag's introduction,
 * `source_conflicts`/`schema_change_log`/`quality_metrics`/`live_game_state`
 * are all empty in production (NBA off-season). Flip to `"true"` only after
 * the real-data verification checklist in `docs/PROGRESS.md`'s "Bettor-trust
 * pivot Phase A follow-up" section clears -- see
 * `docs/superpowers/specs/2026-09-08-bettor-trust-pivot-design.md` §9.
 *
 * Takes an injectable `env` (defaulting to `process.env`), matching
 * `resolveSearchLlmProvider`'s (`web/lib/llm/get-llm-client.ts`) existing
 * pattern -- lets tests pass a plain object instead of mutating global
 * `process.env`.
 */
export function isTrustCenterLive(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.TRUST_CENTER_LIVE === "true";
}
