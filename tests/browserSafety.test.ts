import { describe, expect, it, vi } from "vitest";
import {
  normalizeBrowserNavigationUrl,
  resolveBrowserExtractLimit,
  resolveBrowserSnapshotLimit,
  sanitizeBrowserSnapshot,
} from "../src/browser/safety";
import type { PublicUrlLookup } from "../src/web/publicUrlSafety";

const publicLookup: PublicUrlLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("browser safety controls", () => {
  it("normalizes public browser navigation URLs", async () => {
    await expect(
      normalizeBrowserNavigationUrl("https://example.com/path?q=agent", { lookupImpl: publicLookup }),
    ).resolves.toBe("https://example.com/path?q=agent");
  });

  it("rejects credentialed browser navigation URLs", async () => {
    await expect(
      normalizeBrowserNavigationUrl("https://user:pass@example.com/", { lookupImpl: publicLookup }),
    ).rejects.toThrow("Browser navigation URLs must not include credentials");
  });

  it("rejects localhost and private IP browser navigation URLs before DNS lookup", async () => {
    const lookupMock = vi.fn(publicLookup);

    await expect(
      normalizeBrowserNavigationUrl("http://localhost/internal", { lookupImpl: lookupMock }),
    ).rejects.toThrow("blocked non-public host: localhost");
    await expect(
      normalizeBrowserNavigationUrl("http://127.0.0.1/latest/meta-data", { lookupImpl: lookupMock }),
    ).rejects.toThrow("blocked private IP address: 127.0.0.1");
    await expect(normalizeBrowserNavigationUrl("http://[::1]/", { lookupImpl: lookupMock })).rejects.toThrow(
      "blocked private IP address: ::1",
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects public hostnames that resolve to private addresses", async () => {
    const privateLookup: PublicUrlLookup = async () => [{ address: "10.0.0.5", family: 4 }];

    await expect(
      normalizeBrowserNavigationUrl("https://example.internal.test/", { lookupImpl: privateLookup }),
    ).rejects.toThrow("blocked private resolved address for example.internal.test");
  });

  it("clamps browser extract and snapshot text limits", () => {
    expect(resolveBrowserExtractLimit(undefined)).toBe(6000);
    expect(resolveBrowserExtractLimit(100)).toBe(500);
    expect(resolveBrowserExtractLimit(50_000)).toBe(20_000);
    expect(resolveBrowserSnapshotLimit(undefined)).toBe(4000);
    expect(resolveBrowserSnapshotLimit(50_000)).toBe(12_000);
  });

  it("sanitizes browser snapshots by truncating text and omitting raw screenshots", () => {
    const snapshot = sanitizeBrowserSnapshot(
      {
        url: "https://example.com/",
        title: " Example ",
        text: " First line \n\n" + "x".repeat(1000),
        screenshotBase64: "raw-image-data",
      },
      { maxChars: 20 },
    );

    expect(snapshot).toMatchObject({
      url: "https://example.com/",
      title: "Example",
      truncated: true,
      originalLength: 1011,
      maxChars: 500,
      screenshotIncluded: false,
    });
    expect(snapshot.text).toHaveLength(500);
    expect(snapshot.text.startsWith("First line\n")).toBe(true);
    expect(snapshot).not.toHaveProperty("screenshotBase64");
  });
});
