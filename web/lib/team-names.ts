// Pure data/helpers for team and game display -- no React, no "use client".
// Split out of box-score.tsx so server-only code (API route handlers) can
// import them directly: a "use client" module's exports can't be imported
// into a plain route.ts (it isn't part of the React render tree), which is
// exactly what broke `app/api/teams/[abbreviation]/route.ts` once
// box-score.tsx picked up "use client" for BoxScoreTable's sort state.

/** Mirrors `ingestion/src/ingestion/sources/nba_stats.py`'s
 * `NBA_GAME_ID_OFFSET` -- nba_stats-sourced game_ids are this real
 * balldontlie-space offset plus the raw NBA.com game id, so any real
 * backfilled game_id is far above this threshold. balldontlie's own 2024
 * pilot data (this project's very first, pre-backfill games) sits below
 * it. Used to pick a team's most recent *real* season without a max-season
 * computation mistakenly preferring the pilot's stale 2023 season value
 * over the real, still-growing nba_stats seasons. */
export const NBA_GAME_ID_OFFSET = 100_000_000_000;

export type GameRow = {
  game_id: number;
  game_date: string;
  season: number;
  status: string;
  postseason: boolean;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  source_pulled_at: string;
};

export type PlayerStatRow = {
  // Serialized as a string by the API (see
  // api/src/api/routers/player_stats.py) -- stat_id = game_id * 10_000_000
  // + player_id can reach ~10^18 for nba_stats-sourced rows (offset
  // game_id space), past JS's Number.MAX_SAFE_INTEGER (2^53-1), so a plain
  // `number` here would silently lose precision / collide on real data.
  stat_id: string;
  game_id: number;
  player_id: number;
  player_first_name: string;
  player_last_name: string;
  team: string;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  minutes_played: string | null;
  // Joined in from the game this stat line belongs to (see
  // api/src/api/routers/player_stats.py) -- needed so a player-name search
  // (or a player's full game log) spanning many games can show which game
  // each row came from.
  game_date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
};

/**
 * NBA.com's own player-headshot CDN, keyed by `player_id` -- unofficial
 * (not a public documented API, same low-stakes trade-off category as this
 * project's `nba_api` backfill), but a widely-used, stable convention.
 * `player_id` on `PlayerStatRow` is nba_api's own id space, which is
 * exactly what this endpoint expects (this only works for nba_stats-
 * sourced rows -- balldontlie's `player_id` space is different, but that
 * source's own box-score path is realistically permanently empty, so this
 * isn't a real near-term gap). Players NBA.com hasn't photographed
 * (mostly obscure/historical role players) resolve to a generic silhouette
 * placeholder server-side rather than a broken image or a 404.
 */
export function playerHeadshotUrl(playerId: number): string {
  return `https://cdn.nba.com/headshots/nba/latest/1040x760/${playerId}.png`;
}

/**
 * ESPN's team-logo CDN (`https://a.espncdn.com/i/teamlogos/nba/500/<code>.png`)
 * is keyed by a team code that matches nba_api's own 3-letter
 * `TEAM_ABBREVIATION` for every *current* franchise except two real,
 * verified exceptions (`NOP`->`NO`, `UTA`->`UTAH`; every other current-era
 * code was checked directly against the CDN and returned 200).
 *
 * For *historical* franchises, nba_api preserves the period-accurate
 * abbreviation at the time (see docs/superpowers/specs/2026-09-03-full-
 * nba-history-backfill-design.md for the same period-accuracy property in
 * team *names*) -- e.g. this project's own real backfilled data has `VAN`
 * (Vancouver Grizzlies), `SEA` (Seattle SuperSonics), `NJN` (New Jersey
 * Nets), and `CHH` (the original 1988-2002 Charlotte Hornets, a different
 * abbreviation from the current, unrelated Charlotte franchise's `CHA` --
 * confirmed by checking real games in this app's own data). None of these
 * old codes exist on ESPN's CDN, so they're mapped to the current
 * franchise's logo (the same team, for the ones that relocated/renamed --
 * `CHH` is a judgment call: it shows the *current* Hornets' teal logo,
 * which is the branding fans actually associate with "Hornets," even
 * though official record continuity for those 1988-2002 games actually
 * runs through the Pelicans lineage, not the current Hornets).
 */
const ESPN_LOGO_CODE_OVERRIDES: Record<string, string> = {
  VAN: "MEM",
  SEA: "OKC",
  NJN: "BKN",
  CHH: "CHA",
  NOH: "NO",
  NOP: "NO",
  UTA: "UTAH",
};

export function teamLogoUrlFromAbbreviation(abbreviation: string): string {
  const code = ESPN_LOGO_CODE_OVERRIDES[abbreviation] ?? abbreviation;
  return `https://a.espncdn.com/i/teamlogos/nba/500/${code}.png`;
}

/**
 * `games.home_team`/`away_team` are full names (e.g. "Chicago Bulls"), not
 * abbreviations, but the logo CDN needs an abbreviation -- this maps every
 * name this app's own nba_api-sourced games can carry (verified against
 * real backfilled data for 1996-2003; extended with well-documented
 * franchise history for later eras not yet backfilled) back to its
 * abbreviation, then reuses `teamLogoUrlFromAbbreviation`'s overrides.
 */
export const TEAM_NAME_TO_ABBREVIATION: Record<string, string> = {
  "Atlanta Hawks": "ATL",
  "Boston Celtics": "BOS",
  "Brooklyn Nets": "BKN",
  "New Jersey Nets": "NJN",
  "Charlotte Hornets": "CHA",
  "Charlotte Bobcats": "CHA",
  "Chicago Bulls": "CHI",
  "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL",
  "Denver Nuggets": "DEN",
  "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW",
  "Houston Rockets": "HOU",
  "Indiana Pacers": "IND",
  "Los Angeles Clippers": "LAC",
  "LA Clippers": "LAC",
  "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM",
  "Vancouver Grizzlies": "VAN",
  "Miami Heat": "MIA",
  "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN",
  "New Orleans Pelicans": "NOP",
  "New Orleans Hornets": "NOH",
  "New Orleans/Oklahoma City Hornets": "NOH",
  "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC",
  "Seattle SuperSonics": "SEA",
  "Orlando Magic": "ORL",
  "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX",
  "Portland Trail Blazers": "POR",
  "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS",
  "Toronto Raptors": "TOR",
  "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
  "Washington Bullets": "WAS",
};

export function teamLogoUrlFromName(teamName: string): string | null {
  const abbreviation = TEAM_NAME_TO_ABBREVIATION[teamName];
  return abbreviation ? teamLogoUrlFromAbbreviation(abbreviation) : null;
}

/** Every full name `TEAM_NAME_TO_ABBREVIATION` maps to a given abbreviation
 * -- e.g. `namesForAbbreviation("CHA")` returns both "Charlotte Hornets"
 * and "Charlotte Bobcats". Used by the team detail page to ask `GET
 * /games?team=...` (repeatable) for every game under any historical name
 * a franchise has played under, since the Gold `games` table has no
 * team-id column to key on directly (see `api/src/api/routers/games.py`). */
export function namesForAbbreviation(abbreviation: string): string[] {
  return Object.entries(TEAM_NAME_TO_ABBREVIATION)
    .filter(([, abbr]) => abbr === abbreviation)
    .map(([name]) => name);
}

/** The current (2026), display name for each of the 30 active
 * franchises' abbreviations -- the team detail page's header and its
 * `/teams/<abbreviation>` route only ever address a *current* franchise,
 * never a retired historical one, so this is deliberately not derived
 * from `TEAM_NAME_TO_ABBREVIATION` (which has no marked "current" entry
 * where a franchise has more than one historical name, e.g. CHA). */
export const ABBREVIATION_TO_TEAM_NAME: Record<string, string> = {
  ATL: "Atlanta Hawks",
  BOS: "Boston Celtics",
  BKN: "Brooklyn Nets",
  CHA: "Charlotte Hornets",
  CHI: "Chicago Bulls",
  CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks",
  DEN: "Denver Nuggets",
  DET: "Detroit Pistons",
  GSW: "Golden State Warriors",
  HOU: "Houston Rockets",
  IND: "Indiana Pacers",
  LAC: "LA Clippers",
  LAL: "Los Angeles Lakers",
  MEM: "Memphis Grizzlies",
  MIA: "Miami Heat",
  MIL: "Milwaukee Bucks",
  MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans",
  NYK: "New York Knicks",
  OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic",
  PHI: "Philadelphia 76ers",
  PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers",
  SAC: "Sacramento Kings",
  SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors",
  UTA: "Utah Jazz",
  WAS: "Washington Wizards",
};

/** "YYYY-MM-DD" -> "Jan 5, 2026", parsed as a calendar date (no timezone shift). */
export function formatGameDate(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return dateStr;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function displayScore(score: number | null): string {
  return score === null || score === undefined ? "–" : String(score);
}

/** Bold green for the winning side, bold muted red for the losing side.
 * Neutral (no color) if either score is missing or they're tied -- never
 * guesses a winner from incomplete data. */
export function scoreColorClass(
  thisScore: number | null,
  otherScore: number | null
): string {
  if (thisScore === null || otherScore === null || thisScore === otherScore) {
    return "text-muted-foreground";
  }
  return thisScore > otherScore ? "font-bold text-emerald-500" : "font-bold text-red-500/70";
}
