"""Player-name normalization utilities for cross-season / cross-source matching.

NBA player names arrive inconsistently across seasons and sources: suffixes
(``Jr.``, ``Sr.``, ``II``, ``III``, ``IV``) are sometimes present or absent,
formatted with or without a comma/period, diacritics vary by source
(``Dončić`` vs ``Doncic``), and whitespace/casing can differ. This module
provides two complementary functions:

- :func:`clean_display_name` — a display-safe cleanup that preserves accents
  and casing but standardizes whitespace and suffix formatting.
- :func:`normalize_player_key` — a stable ASCII matching key built on top of
  :func:`clean_display_name`, for joining/deduplicating the same player
  across independently-maintained sources.
"""

from __future__ import annotations

import re
import unicodedata

# Recognized name suffixes, matched case-insensitively, with or without a
# trailing period and with or without a leading comma. Ordered longest-first
# where it matters for readability (not required for correctness here since
# each pattern is anchored to a distinct token).
_SUFFIX_CANONICAL = {
    "jr": "Jr.",
    "sr": "Sr.",
    "ii": "II",
    "iii": "III",
    "iv": "IV",
}

# Matches an optional comma, whitespace, then one of the known suffix tokens
# (with an optional trailing period), anchored at the end of the string.
_SUFFIX_RE = re.compile(
    r"[,\s]*\b(?P<suffix>Jr|Sr|II|III|IV)\.?\s*$",
    re.IGNORECASE,
)

_WHITESPACE_RE = re.compile(r"\s+")

# Unicode combining marks (accents, diacritics) stripped after NFKD
# decomposition to build the ASCII matching key.
_COMBINING_MARK_CATEGORY = "Mn"


def clean_display_name(raw_name: str) -> str:
    """Trim/collapse whitespace and standardize suffix formatting (accents preserved for display)."""
    # Collapses any run of internal whitespace to a single space and trims
    # surrounding whitespace. If the name ends with a recognized suffix
    # token (Jr, Sr, II, III, IV), regardless of a preceding comma, trailing
    # period, or casing, it is rewritten to the canonical form (e.g. "Jr.",
    # "III") preceded by exactly one space and no comma.
    if not raw_name:
        return ""

    collapsed = _WHITESPACE_RE.sub(" ", raw_name.strip())
    if not collapsed:
        return ""

    match = _SUFFIX_RE.search(collapsed)
    if not match:
        return collapsed

    base = collapsed[: match.start()].rstrip().rstrip(",").rstrip()
    suffix_key = match.group("suffix").lower()
    canonical_suffix = _SUFFIX_CANONICAL[suffix_key]

    if not base:
        # Degenerate input that is *only* a suffix token (e.g. "Jr.") — no
        # name to prepend, so just return the canonicalized suffix.
        return canonical_suffix

    return f"{base} {canonical_suffix}"


def normalize_player_key(raw_name: str) -> str:
    """Build a diacritic-stripped, lowercase, single-space-collapsed ASCII matching key."""
    # Applies clean_display_name first, then strips diacritics via Unicode
    # NFKD decomposition + combining-mark removal, lowercases, and collapses
    # whitespace to single spaces (not underscores) so the key stays
    # human-readable in logs/SQL joins. Suitable for joining/deduplicating
    # the same player across independently-maintained sources and seasons.
    cleaned = clean_display_name(raw_name)
    if not cleaned:
        return ""

    decomposed = unicodedata.normalize("NFKD", cleaned)
    without_marks = "".join(
        ch for ch in decomposed if unicodedata.category(ch) != _COMBINING_MARK_CATEGORY
    )
    # NFKD may leave the ASCII form recombined/decomposed further (e.g. some
    # ligatures); re-normalize once more to NFC-equivalent plain text before
    # lowercasing, then collapse whitespace defensively (clean_display_name
    # already collapsed it, but stripping marks can't introduce whitespace
    # anyway — this is just defense in depth).
    key = _WHITESPACE_RE.sub(" ", without_marks.strip()).lower()
    return key
