export type NormalizedDateConfidence = "high" | "medium" | "low";

export interface DateValidation {
  source_text: string;
  normalized_date?: string;
  basis_date: string;
  timezone: string;
  is_past?: boolean;
  is_today?: boolean;
  weekday_text?: string;
  weekday_matches?: boolean;
  warnings: string[];
}

export interface NormalizedDateResult {
  original_text: string;
  normalized_date?: string;
  basis_date: string;
  timezone: string;
  is_past?: boolean;
  is_today?: boolean;
  weekday_text?: string;
  weekday?: string;
  weekday_matches?: boolean;
  confidence: NormalizedDateConfidence;
  warnings: string[];
  date_validation: DateValidation;
}

interface NormalizeDateInput {
  expression: string;
  basisDate?: string;
  timezone?: string;
}

interface ParsedDate {
  year: number;
  month: number;
  day: number;
  confidence: NormalizedDateConfidence;
  warnings: string[];
}

interface WeekdayMatch {
  text: string;
  index: number;
  weekday: string;
}

const DEFAULT_TIMEZONE = "Asia/Tokyo";
const WEEKDAYS = [
  { name: "sunday", tokens: [/日曜日?/, /[（(\s]日[）)\s]/, /\bsun(?:day)?\b/i] },
  { name: "monday", tokens: [/月曜日?/, /[（(\s]月[）)\s]/, /\bmon(?:day)?\b/i] },
  { name: "tuesday", tokens: [/火曜日?/, /[（(\s]火[）)\s]/, /\btue(?:sday)?\b/i] },
  { name: "wednesday", tokens: [/水曜日?/, /[（(\s]水[）)\s]/, /\bwed(?:nesday)?\b/i] },
  { name: "thursday", tokens: [/木曜日?/, /[（(\s]木[）)\s]/, /\bthu(?:rsday)?\b/i] },
  { name: "friday", tokens: [/金曜日?/, /[（(\s]金[）)\s]/, /\bfri(?:day)?\b/i] },
  { name: "saturday", tokens: [/土曜日?/, /[（(\s]土[）)\s]/, /\bsat(?:urday)?\b/i] },
] as const;

export function normalizeDateExpression(input: NormalizeDateInput): NormalizedDateResult {
  const originalText = input.expression.trim();
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  const basisDate = normalizeDateOnly(input.basisDate) ?? currentDateForTimeZone(timezone);
  const parsedDate = parseDateExpression(originalText, basisDate);
  const weekday = extractWeekday(originalText);
  const warnings = [...(parsedDate?.warnings ?? [])];
  const normalizedDate = parsedDate ? formatDateOnly(parsedDate.year, parsedDate.month, parsedDate.day) : undefined;
  const isPast = normalizedDate ? normalizedDate < basisDate : undefined;
  const isToday = normalizedDate ? normalizedDate === basisDate : undefined;
  const weekdayMatches =
    normalizedDate && weekday ? weekday.index === weekdayIndexForDate(normalizedDate) : undefined;

  if (!parsedDate) {
    warnings.push("No supported date expression was found.");
  }
  if (isPast) {
    warnings.push("Resolved date is before the basis date.");
  }
  if (weekdayMatches === false) {
    warnings.push("Weekday text does not match the resolved date.");
  }

  const dateValidation: DateValidation = {
    source_text: originalText,
    normalized_date: normalizedDate,
    basis_date: basisDate,
    timezone,
    is_past: isPast,
    is_today: isToday,
    weekday_text: weekday?.text,
    weekday_matches: weekdayMatches,
    warnings,
  };

  return {
    original_text: originalText,
    normalized_date: normalizedDate,
    basis_date: basisDate,
    timezone,
    is_past: isPast,
    is_today: isToday,
    weekday_text: weekday?.text,
    weekday: weekday?.weekday,
    weekday_matches: weekdayMatches,
    confidence: parsedDate?.confidence ?? "low",
    warnings,
    date_validation: dateValidation,
  };
}

function parseDateExpression(text: string, basisDate: string): ParsedDate | undefined {
  const basis = parseDateOnly(basisDate);
  if (!basis) {
    throw new Error(`Invalid basis_date: ${basisDate}`);
  }

  const fullDate = text.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/);
  if (fullDate) {
    return validParsedDate(Number(fullDate[1]), Number(fullDate[2]), Number(fullDate[3]), "high");
  }

  const japaneseFullDate = text.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (japaneseFullDate) {
    return validParsedDate(
      Number(japaneseFullDate[1]),
      Number(japaneseFullDate[2]),
      Number(japaneseFullDate[3]),
      "high",
    );
  }

  const relative = parseRelativeDate(text, basisDate);
  if (relative) {
    return relative;
  }

  const monthDay = text.match(/(?:^|[^\d])(\d{1,2})[/-](\d{1,2})(?:[^\d]|$)/);
  if (monthDay) {
    return validParsedDate(Number(basis.year), Number(monthDay[1]), Number(monthDay[2]), "medium", [
      "Year was inferred from the basis date.",
    ]);
  }

  const japaneseMonthDay = text.match(/(\d{1,2})月\s*(\d{1,2})日/);
  if (japaneseMonthDay) {
    return validParsedDate(Number(basis.year), Number(japaneseMonthDay[1]), Number(japaneseMonthDay[2]), "medium", [
      "Year was inferred from the basis date.",
    ]);
  }

  if (/\bnext\s+week\b|来週/i.test(text) || /\blast\s+week\b|先週/i.test(text)) {
    return undefined;
  }

  return undefined;
}

function parseRelativeDate(text: string, basisDate: string): ParsedDate | undefined {
  if (/\btoday\b|今日/i.test(text)) {
    return parseDateOnlyAsParsedDate(basisDate, "high");
  }
  if (/\btomorrow\b|明日/i.test(text)) {
    return parseDateOnlyAsParsedDate(addDays(basisDate, 1), "high");
  }
  if (/\byesterday\b|昨日/i.test(text)) {
    return parseDateOnlyAsParsedDate(addDays(basisDate, -1), "high");
  }

  return undefined;
}

function validParsedDate(
  year: number,
  month: number,
  day: number,
  confidence: NormalizedDateConfidence,
  warnings: string[] = [],
): ParsedDate | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return { year, month, day, confidence, warnings };
}

function parseDateOnlyAsParsedDate(value: string, confidence: NormalizedDateConfidence): ParsedDate | undefined {
  const parsed = parseDateOnly(value);
  if (!parsed) {
    return undefined;
  }
  return { ...parsed, confidence, warnings: [] };
}

function normalizeDateOnly(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseDateOnly(value);
  return parsed ? formatDateOnly(parsed.year, parsed.month, parsed.day) : undefined;
}

function parseDateOnly(value: string): { year: number; month: number; day: number } | undefined {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return validParsedDate(year, month, day, "high");
}

function currentDateForTimeZone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Could not determine current date for timezone: ${timezone}`);
  }

  return `${year}-${month}-${day}`;
}

function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDateOnly(year: number, month: number, day: number): string {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function extractWeekday(text: string): WeekdayMatch | undefined {
  for (const [index, weekday] of WEEKDAYS.entries()) {
    for (const token of weekday.tokens) {
      const match = text.match(token);
      if (match?.[0]) {
        return {
          text: match[0],
          index,
          weekday: weekday.name,
        };
      }
    }
  }

  return undefined;
}

function weekdayIndexForDate(dateOnly: string): number {
  return new Date(`${dateOnly}T00:00:00.000Z`).getUTCDay();
}
