import pytest

from ingestion.normalization import clean_display_name, normalize_player_key


# ---------------------------------------------------------------------------
# clean_display_name: suffix formatting
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "LeBron James, Jr.",
        "LeBron James Jr",
        "LeBron James Jr.",
        "LeBron James  JR.",
        "LeBron James, jr",
        "LeBron James ,  Jr.",
        "  LeBron James, Jr.  ",
    ],
)
def test_clean_display_name_collapses_suffix_variants(raw):
    assert clean_display_name(raw) == "LeBron James Jr."


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Robert Griffin III", "Robert Griffin III"),
        ("Robert Griffin, III", "Robert Griffin III"),
        ("robert griffin iii", "robert griffin III"),
        ("Julius Erving II", "Julius Erving II"),
        ("Some Player IV", "Some Player IV"),
        ("Some Player, Sr.", "Some Player Sr."),
        ("Some Player SR", "Some Player Sr."),
    ],
)
def test_clean_display_name_handles_all_suffix_tokens(raw, expected):
    assert clean_display_name(raw) == expected


def test_clean_display_name_suffix_only_input_does_not_raise():
    # Degenerate input with nothing but a suffix token: no name to prepend.
    assert clean_display_name("Jr.") == "Jr."
    assert clean_display_name("jr") == "Jr."


# ---------------------------------------------------------------------------
# clean_display_name: whitespace handling
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("  Steph   Curry  ", "Steph Curry"),
        ("Steph\tCurry", "Steph Curry"),
        ("Steph\n\nCurry", "Steph Curry"),
        ("   ", ""),
    ],
)
def test_clean_display_name_collapses_whitespace(raw, expected):
    assert clean_display_name(raw) == expected


# ---------------------------------------------------------------------------
# clean_display_name: idempotency / pass-through
# ---------------------------------------------------------------------------


def test_clean_display_name_passes_through_plain_name_unchanged():
    assert clean_display_name("Stephen Curry") == "Stephen Curry"


def test_clean_display_name_is_idempotent():
    once = clean_display_name("LeBron James,   jr.")
    twice = clean_display_name(once)
    assert once == twice == "LeBron James Jr."


def test_clean_display_name_preserves_diacritics_for_display():
    assert clean_display_name("Luka Dončić") == "Luka Dončić"
    assert clean_display_name("  Nikola   Jokić  ") == "Nikola Jokić"


# ---------------------------------------------------------------------------
# normalize_player_key: diacritic-insensitivity
# ---------------------------------------------------------------------------


def test_normalize_player_key_strips_diacritics_to_match_ascii_variant():
    assert normalize_player_key("Luka Dončić") == normalize_player_key("Luka Doncic")


def test_normalize_player_key_matches_across_whitespace_and_case():
    assert normalize_player_key("Nikola Jokić") == normalize_player_key("nikola   jokic")


def test_normalize_player_key_matches_across_suffix_formatting():
    assert normalize_player_key("LeBron James, Jr.") == normalize_player_key(
        "lebron   james jr"
    )


def test_normalize_player_key_is_lowercase_ascii():
    key = normalize_player_key("Dončić")
    assert key == "doncic"
    assert key.isascii()
    assert key == key.lower()


# ---------------------------------------------------------------------------
# normalize_player_key: does not over-normalize distinct players
# ---------------------------------------------------------------------------


def test_normalize_player_key_does_not_collapse_distinct_players():
    assert normalize_player_key("LeBron James") != normalize_player_key("Lebron Jones")


def test_normalize_player_key_does_not_collapse_similar_suffixed_players():
    assert normalize_player_key("Robert Griffin III") != normalize_player_key(
        "Robert Griffin II"
    )


# ---------------------------------------------------------------------------
# Edge cases: empty strings / single-word names must not raise
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("raw", ["", "   ", "\t\n"])
def test_clean_display_name_empty_and_blank_inputs_do_not_raise(raw):
    assert clean_display_name(raw) == ""


@pytest.mark.parametrize("raw", ["", "   ", "\t\n"])
def test_normalize_player_key_empty_and_blank_inputs_do_not_raise(raw):
    assert normalize_player_key(raw) == ""


@pytest.mark.parametrize("raw", ["Zion", "Yao", "Giannis"])
def test_single_word_names_do_not_raise_and_round_trip(raw):
    cleaned = clean_display_name(raw)
    assert cleaned == raw
    key = normalize_player_key(raw)
    assert key == raw.lower()


def test_single_word_name_is_not_mistaken_for_a_suffix():
    # "Yao" / "Giannis" etc. must not be truncated by the suffix stripper.
    assert clean_display_name("Giannis") == "Giannis"
    assert normalize_player_key("Giannis") == "giannis"
