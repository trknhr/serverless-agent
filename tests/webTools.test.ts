import { describe, expect, it, vi } from "vitest";
import { WebToolsProvider } from "../src/web/webTools";

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("WebToolsProvider", () => {
  it("calls Brave web search with GET query parameters and normalizes results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        web: {
          results: [
            {
              title: "Result <b>One</b>",
              url: "https://example.com/one",
              description: "Snippet &amp; details",
              age: "2026-05-20",
              language: "en",
              profile: { name: "Example" },
            },
            {
              title: "",
              url: "https://example.com/empty-title",
            },
          ],
        },
      }),
    );
    const provider = new WebToolsProvider({
      searchProvider: "brave",
      searchApiKeyProvider: async () => "brave-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      provider.search({
        query: "agent tools",
        limit: 3,
        country: "jp",
        language: "JA",
        freshness: "week",
        domains: ["https://docs.aws.amazon.com/bedrock/latest/userguide/", "bad host"],
      }),
    ).resolves.toEqual({
      provider: "brave",
      query: "agent tools",
      count: 1,
      results: [
        {
          title: "Result One",
          url: "https://example.com/one",
          description: "Snippet & details",
          publishedAt: "2026-05-20",
          language: "en",
          sourceName: "Example",
        },
      ],
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(requestUrl);
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("agent tools site:docs.aws.amazon.com");
    expect(url.searchParams.get("count")).toBe("3");
    expect(url.searchParams.get("country")).toBe("JP");
    expect(url.searchParams.get("search_lang")).toBe("ja");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect(url.searchParams.get("result_filter")).toBe("web");
    expect(requestInit).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({
        "x-subscription-token": "brave-key",
      }),
    });
    expect(requestInit.body).toBeUndefined();
  });

  it("calls a configured SearXNG instance without an API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        results: [
          {
            title: "Self hosted result",
            url: "https://example.net/post",
            content: "SearXNG snippet",
            publishedDate: "2026-05-21",
            engine: "duckduckgo",
          },
        ],
      }),
    );
    const provider = new WebToolsProvider({
      searchProvider: "searxng",
      searchBaseUrl: "https://search.example.org",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      provider.search({
        query: "agent tools",
        language: "ja",
        freshness: "day",
        domains: ["example.net"],
      }),
    ).resolves.toEqual({
      provider: "searxng",
      query: "agent tools",
      count: 1,
      results: [
        {
          title: "Self hosted result",
          url: "https://example.net/post",
          description: "SearXNG snippet",
          publishedAt: "2026-05-21",
          sourceName: "duckduckgo",
        },
      ],
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(requestUrl);
    expect(url.origin + url.pathname).toBe("https://search.example.org/search");
    expect(url.searchParams.get("q")).toBe("agent tools site:example.net");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("language")).toBe("ja");
    expect(url.searchParams.get("time_range")).toBe("day");
    expect(requestInit).toMatchObject({ method: "GET" });
  });

  it("extracts readable HTML through Readability and strips active content", async () => {
    const html = [
      "<!doctype html>",
      "<html>",
      "<head><title>Fallback title</title></head>",
      "<body>",
      "<nav>Navigation should be removed</nav>",
      "<article>",
      "<h1>Readable heading</h1>",
      "<p>First&nbsp;paragraph.</p>",
      "<p>Second paragraph.</p>",
      "<script>secret()</script>",
      "</article>",
      "</body>",
      "</html>",
    ].join("");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const provider = new WebToolsProvider({
      fetchImpl: fetchMock as unknown as typeof fetch,
      lookupImpl: publicLookup,
    });

    const result = await provider.extract({
      url: "https://example.com/article",
      maxChars: 500,
    });

    expect(result).toMatchObject({
      url: "https://example.com/article",
      finalUrl: "https://example.com/article",
      title: "Fallback title",
      contentType: "text/html; charset=utf-8",
      truncated: false,
    });
    expect(result.text).toContain("Readable heading");
    expect(result.text).toContain("First paragraph.");
    expect(result.text).toContain("Second paragraph.");
    expect(result.text).not.toContain("secret");
    expect(result.text).not.toContain("Navigation should be removed");
  });

  it("blocks redirects to private addresses before following them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/latest/meta-data" },
      }),
    );
    const provider = new WebToolsProvider({
      fetchImpl: fetchMock as unknown as typeof fetch,
      lookupImpl: publicLookup,
    });

    await expect(provider.extract({ url: "https://example.com/redirect" })).rejects.toThrow(
      "blocked private IP address",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-text content types", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    const provider = new WebToolsProvider({
      fetchImpl: fetchMock as unknown as typeof fetch,
      lookupImpl: publicLookup,
    });

    await expect(provider.extract({ url: "https://example.com/file.pdf" })).rejects.toThrow(
      "readable text or HTML content",
    );
  });
});
