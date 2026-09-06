import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SearchResultDataView } from "./search-result-tables";
import type { SearchResultData } from "@/lib/search-result-types";
import type { GameRow, PlayerStatRow } from "@/lib/team-names";

afterEach(() => {
  // No global `afterEach` is registered (`vitest.config.mts` doesn't set
  // `test.globals: true`), so `@testing-library/react`'s automatic
  // per-test cleanup never triggers on its own -- do it explicitly, or a
  // second `render()` in a later test in this file leaves the previous
  // test's DOM behind and queries start matching duplicate elements (same
  // pattern as `search-section.test.tsx`).
  cleanup();
});

const SAMPLE_GAME: GameRow = {
  game_id: 1, game_date: "2024-01-03", season: 2023, status: "Final", postseason: false,
  home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97,
  source_pulled_at: "",
};

const SAMPLE_STAT_ROW: PlayerStatRow = {
  stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić",
  team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31",
  game_date: "2024-01-03", home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers",
  home_score: 126, away_score: 97,
};

describe("SearchResultDataView", () => {
  it("renders nothing for null resultData", () => {
    const { container } = render(<SearchResultDataView resultData={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a BoxScoreTable for player_stats", () => {
    const resultData: SearchResultData = {
      type: "player_stats",
      payload: { playerName: "Luka Dončić", games: [SAMPLE_STAT_ROW] },
    };
    render(<SearchResultDataView resultData={resultData} />);
    // "Dončić" is split across sibling text nodes by BoxScoreTable's
    // `{first} {last}` JSX (unchanged, already-shipped code) -- getByText's
    // default exact-string matcher never sees a single node containing just
    // "Dončić", so match by substring instead.
    expect(screen.getByText(/Dončić/)).toBeInTheDocument();
    expect(screen.getByText("41")).toBeInTheDocument();
  });

  it("renders a matchup card + box score for game_result", () => {
    const resultData: SearchResultData = {
      type: "game_result",
      payload: { game: SAMPLE_GAME, boxScore: [SAMPLE_STAT_ROW] },
    };
    render(<SearchResultDataView resultData={resultData} />);
    expect(screen.getByText("Dallas Mavericks")).toBeInTheDocument();
    expect(screen.getByText("126")).toBeInTheDocument();
    expect(screen.getByText(/Dončić/)).toBeInTheDocument();
  });

  it("renders one matchup card per game for team_games", () => {
    const secondGame: GameRow = { ...SAMPLE_GAME, game_id: 2, game_date: "2024-01-07", home_team: "Boston Celtics", away_team: "Miami Heat", home_score: 101, away_score: 98 };
    const resultData: SearchResultData = {
      type: "team_games",
      payload: { team: "Boston Celtics", games: [SAMPLE_GAME, secondGame] },
    };
    render(<SearchResultDataView resultData={resultData} />);
    expect(screen.getByText("Dallas Mavericks")).toBeInTheDocument();
    expect(screen.getByText("Boston Celtics")).toBeInTheDocument();
  });

  it("renders a ranked table for leaders", () => {
    const resultData: SearchResultData = {
      type: "leaders",
      payload: {
        stat: "points",
        gameCount: 26,
        leaders: [
          { player_id: 203944, player_name: "Julius Randle", value: 74 },
          { player_id: 1630162, player_name: "Anthony Edwards", value: 70 },
        ],
      },
    };
    render(<SearchResultDataView resultData={resultData} />);
    expect(screen.getByText("Julius Randle")).toBeInTheDocument();
    expect(screen.getByText("74")).toBeInTheDocument();
    expect(screen.getByText(/26 games/)).toBeInTheDocument();
  });
});
