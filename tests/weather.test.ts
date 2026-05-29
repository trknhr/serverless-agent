import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenMeteoWeatherProvider,
  buildWeatherLocationQueries,
  buildUmbrellaNote,
  weatherCodeToJapanese,
} from "../src/weather/openMeteo";

describe("weather helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("maps Open-Meteo weather codes to Japanese labels", () => {
    expect(weatherCodeToJapanese(0)).toBe("快晴");
    expect(weatherCodeToJapanese(3)).toBe("くもり");
    expect(weatherCodeToJapanese(61)).toBe("雨");
    expect(weatherCodeToJapanese(95)).toBe("雷雨");
    expect(weatherCodeToJapanese(999)).toBe("不明");
  });

  it("builds umbrella guidance from rain probability, precipitation, and weather code", () => {
    expect(buildUmbrellaNote(20, 0, 1)).toBe("傘は不要そうです。");
    expect(buildUmbrellaNote(35, 0, 2)).toBe("折りたたみ傘があると安心です。");
    expect(buildUmbrellaNote(55, 0, 2)).toBe("傘があると安心です。");
    expect(buildUmbrellaNote(10, 1.2, 2)).toBe("傘があると安心です。");
    expect(buildUmbrellaNote(10, 0, 61)).toBe("傘があると安心です。");
  });

  it("builds fallback location queries for Japanese administrative names", () => {
    expect(buildWeatherLocationQueries("福岡県福岡市")).toEqual(["福岡県福岡市", "福岡市"]);
    expect(buildWeatherLocationQueries("福岡")).toEqual(["福岡", "福岡市"]);
  });

  it("falls back to a city query when the full Japanese location is not found", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T00:00:00+09:00"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ generationtime_ms: 0.1 }))
      .mockResolvedValueOnce(jsonResponse({
        results: [
          {
            name: "福岡市",
            country: "日本",
            country_code: "JP",
            admin1: "福岡県",
            latitude: 33.6,
            longitude: 130.41667,
            timezone: "Asia/Tokyo",
            population: 1_612_392,
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        daily: {
          time: ["2026-05-26"],
          weather_code: [61],
          temperature_2m_max: [27.7],
          temperature_2m_min: [20.4],
          precipitation_probability_max: [62],
          precipitation_sum: [3.7],
          wind_speed_10m_max: [7.9],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const forecast = await new OpenMeteoWeatherProvider().getForecast({
      location: "福岡県福岡市",
      date: "2026-05-26",
      timezone: "Asia/Tokyo",
    });

    expect(forecast.locationName).toBe("福岡市");
    expect(forecast.admin1).toBe("福岡県");
    expect(forecast.summary).toContain("雨");
    expect(forecast.summary).toContain("降水確率62%");
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("name")).toBe("福岡県福岡市");
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("name")).toBe("福岡市");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
