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

  it("caps team_games rendering at 15 cards and shows a 'Showing X of Y' line when the count exceeds the cap", () => {
    const games: GameRow[] = Array.from({ length: 47 }, (_, index) => ({
      ...SAMPLE_GAME,
      game_id: index + 1,
      game_date: `2024-01-${String((index % 28) + 1).padStart(2, "0")}`,
    }));
    const resultData: SearchResultData = {
      type: "team_games",
      payload: { team: "Dallas Mavericks", games },
    };
    render(<SearchResultDataView resultData={resultData} />);

    // GameMatchupCard renders each game's status badge ("Final" here, since
    // every SAMPLE_GAME-derived row shares that status) -- one badge per
    // rendered card is a reliable proxy for the card count.
    expect(screen.getAllByText("Final")).toHaveLength(15);
    expect(screen.getByText("Showing 15 of 47 games")).toBeInTheDocument();
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
    const { container } = render(<SearchResultDataView resultData={resultData} />);
    expect(screen.getByText("Julius Randle")).toBeInTheDocument();
    expect(screen.getByText("74")).toBeInTheDocument();
    expect(screen.getByText(/26 games/)).toBeInTheDocument();
    // Each leader row shows a headshot, same as BoxScoreTable's player rows.
    // The images are decorative (alt=""), so they don't have an accessible
    // "img" role -- query the DOM directly instead of screen.getByRole.
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute("src")).toContain("203944");
    expect(images[1].getAttribute("src")).toContain("1630162");
  });
});

describe("SearchResultDataView -- stat_aggregate", () => {
  it("renders the headline value and a truncation note for a truncated count", () => {
    const resultData: SearchResultData = {
      type: "stat_aggregate",
      payload: {
        playerName: "LeBron James",
        stat: "points",
        operation: "count_over_threshold",
        threshold: 30,
        value: 47,
        extremeGame: null,
        matchingGames: [SAMPLE_STAT_ROW],
        matchingGamesTruncated: true,
        gameCountConsidered: 1600,
      },
    };
    render(<SearchResultDataView resultData={resultData} />);
    // "47" alone also appears inside "Showing 1 of 47" below, so match the
    // full headline phrase to pin this assertion to the headline element.
    expect(screen.getByText(/47 games at or above 30 points/)).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 47/)).toBeInTheDocument();
  });

  it("renders the extreme game for a max operation without a truncation note", () => {
    const resultData: SearchResultData = {
      type: "stat_aggregate",
      payload: {
        playerName: "Luka Dončić",
        stat: "rebounds",
        operation: "max",
        threshold: null,
        value: 6,
        extremeGame: SAMPLE_STAT_ROW,
        matchingGames: null,
        matchingGamesTruncated: false,
        gameCountConsidered: 5,
      },
    };
    render(<SearchResultDataView resultData={resultData} />);
    // Bare "6" also appears inside the extreme game's own box score row
    // (e.g. its rebounds cell) -- match the full headline phrase instead.
    expect(screen.getByText(/high rebounds: 6/)).toBeInTheDocument();
    // "Dončić" legitimately renders twice here: once in the headline
    // (playerName) and once in the extreme game's box score row.
    expect(screen.getAllByText(/Dončić/)).toHaveLength(2);
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it("renders a bare headline for a sum/avg operation with no per-game rows", () => {
    const resultData: SearchResultData = {
      type: "stat_aggregate",
      payload: {
        playerName: "LeBron James",
        stat: "points",
        operation: "avg",
        threshold: null,
        value: 27.3,
        extremeGame: null,
        matchingGames: null,
        matchingGamesTruncated: false,
        gameCountConsidered: 30,
      },
    };
    render(<SearchResultDataView resultData={resultData} />);
    expect(screen.getByText(/27.3/)).toBeInTheDocument();
  });
});

describe("SearchResultDataView -- player_streak", () => {
  it("renders the streak length, an Active badge when isActive, and the streak's games", () => {
    const resultData: SearchResultData = {
      type: "player_streak",
      payload: {
        playerName: "LeBron James",
        stat: "points",
        threshold: 20,
        longestStreak: 9,
        isActive: true,
        games: [SAMPLE_STAT_ROW],
      },
    };
    render(<SearchResultDataView resultData={resultData} />);
    // Bare "9" also appears inside SAMPLE_STAT_ROW's own box score row (the
    // away score is 97) -- match the full headline phrase instead.
    expect(screen.getByText(/9-game streak/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Dončić/)).toBeInTheDocument();
  });

  it("does not render an Active badge when isActive is false", () => {
    const resultData: SearchResultData = {
      type: "player_streak",
      payload: {
        playerName: "LeBron James",
        stat: "points",
        threshold: 20,
        longestStreak: 5,
        isActive: false,
        games: [SAMPLE_STAT_ROW],
      },
    };
    render(<SearchResultDataView resultData={resultData} />);
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });
});
