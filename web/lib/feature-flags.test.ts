import { describe, expect, it } from "vitest";

import { isTrustCenterLive } from "@/lib/feature-flags";

describe("isTrustCenterLive", () => {
  it("defaults to false when unset", () => {
    expect(isTrustCenterLive({})).toBe(false);
  });

  it("is false for any value other than the exact string \"true\"", () => {
    expect(isTrustCenterLive({ TRUST_CENTER_LIVE: "1" })).toBe(false);
    expect(isTrustCenterLive({ TRUST_CENTER_LIVE: "True" })).toBe(false);
    expect(isTrustCenterLive({ TRUST_CENTER_LIVE: "yes" })).toBe(false);
  });

  it("is true only when explicitly set to \"true\"", () => {
    expect(isTrustCenterLive({ TRUST_CENTER_LIVE: "true" })).toBe(true);
  });
});
