import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatFreshness,
  formatScheduledStart,
  getStatusPresentation,
} from "@/lib/board";

describe("getStatusPresentation", () => {
  it("returns the live presentation for status 'live'", () => {
    const result = getStatusPresentation("live");
    expect(result.kind).toBe("live");
    expect(result.label).toBe("LIVE");
  });

  it("returns the final presentation for status 'final'", () => {
    const result = getStatusPresentation("final");
    expect(result).toEqual({ kind: "static", label: "Final", variant: "secondary" });
  });

  it("returns the scheduled presentation for status 'scheduled'", () => {
    const result = getStatusPresentation("scheduled");
    expect(result).toEqual({ kind: "static", label: "Sched", variant: "outline" });
  });

  it("returns the postponed presentation for status 'postponed'", () => {
    const result = getStatusPresentation("postponed");
    expect(result).toEqual({ kind: "static", label: "Postponed", variant: "destructive" });
  });
});

describe("formatFreshness", () => {
  beforeEach(() => {
    // Fixed "now" so elapsed-time math is deterministic rather than
    // tolerance-based.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the em dash for a null timestamp", () => {
    expect(formatFreshness(null)).toBe("—");
  });

  it("renders a timestamp a few seconds in the past as 'Ns ago'", () => {
    const fiveSecondsAgo = "2026-01-01T00:00:25.000Z";
    expect(formatFreshness(fiveSecondsAgo)).toBe("5s ago");
  });

  it("returns the em dash for an invalid date string", () => {
    expect(formatFreshness("not-a-date")).toBe("—");
  });
});

describe("formatScheduledStart", () => {
  it("returns the em dash for a null input", () => {
    expect(formatScheduledStart(null)).toBe("—");
  });

  it("formats a valid ISO string with an 'ET' suffix", () => {
    const result = formatScheduledStart("2026-09-07T00:30:00+00:00");
    expect(result).toContain("ET");
  });

  it("returns the em dash for an invalid date string", () => {
    expect(formatScheduledStart("not-a-date")).toBe("—");
  });
});
