import { PLAN_TEMPLATE, type Plan, type PlanItem } from "@/lib/calendarTemplate";
import type { ContentItem, ContentStatus, DynamicCalendarStore } from "./types";

export interface CalendarDayInfo {
  dateKey: string; // YYYY-MM-DD
  dayNumber: number;
  month: number; // 0-indexed (0 = Jan, 11 = Dec)
  year: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
}

/**
 * Formats a Date object or components into YYYY-MM-DD string consistently.
 */
export function formatDateKey(year: number, month: number, day: number): string {
  const y = String(year).padStart(4, "0");
  const m = String(month + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dateToKey(date: Date): string {
  return formatDateKey(date.getFullYear(), date.getMonth(), date.getDate());
}

export function keyToDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function formatDisplayDate(dateKey: string): string {
  if (!dateKey) return "";
  const d = keyToDate(dateKey);
  if (isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function getTodayKey(): string {
  return dateToKey(new Date());
}

/**
 * Computes a 35 or 42 cell matrix for the calendar month view.
 * Handles month boundaries, leap years, and leading/trailing days.
 */
export function getMonthMatrix(year: number, month: number): CalendarDayInfo[] {
  const todayKey = getTodayKey();
  const firstDayOfMonth = new Date(year, month, 1);
  const startingDayOfWeek = firstDayOfMonth.getDay(); // 0 = Sun, 6 = Sat

  // Days in current month
  const daysInCurrentMonth = new Date(year, month + 1, 0).getDate();
  // Days in previous month
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const days: CalendarDayInfo[] = [];

  // Leading days from previous month
  const prevMonthYear = month === 0 ? year - 1 : year;
  const prevMonthIndex = month === 0 ? 11 : month - 1;
  for (let i = startingDayOfWeek - 1; i >= 0; i--) {
    const dayNum = daysInPrevMonth - i;
    const dateKey = formatDateKey(prevMonthYear, prevMonthIndex, dayNum);
    const dayOfWeek = (startingDayOfWeek - 1 - i + 7) % 7;
    days.push({
      dateKey,
      dayNumber: dayNum,
      month: prevMonthIndex,
      year: prevMonthYear,
      isCurrentMonth: false,
      isToday: dateKey === todayKey,
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6
    });
  }

  // Days in current month
  for (let dayNum = 1; dayNum <= daysInCurrentMonth; dayNum++) {
    const dateKey = formatDateKey(year, month, dayNum);
    const dayOfWeek = new Date(year, month, dayNum).getDay();
    days.push({
      dateKey,
      dayNumber: dayNum,
      month,
      year,
      isCurrentMonth: true,
      isToday: dateKey === todayKey,
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6
    });
  }

  // Trailing days from next month to fill 5 or 6 weeks (multiples of 7)
  const totalCells = days.length <= 35 ? 35 : 42;
  const trailingDaysNeeded = totalCells - days.length;
  const nextMonthYear = month === 11 ? year + 1 : year;
  const nextMonthIndex = month === 11 ? 0 : month + 1;

  for (let dayNum = 1; dayNum <= trailingDaysNeeded; dayNum++) {
    const dateKey = formatDateKey(nextMonthYear, nextMonthIndex, dayNum);
    const dayOfWeek = new Date(nextMonthYear, nextMonthIndex, dayNum).getDay();
    days.push({
      dateKey,
      dayNumber: dayNum,
      month: nextMonthIndex,
      year: nextMonthYear,
      isCurrentMonth: false,
      isToday: dateKey === todayKey,
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6
    });
  }

  return days;
}

/**
 * Computes 7 days for the week view centered around a reference date.
 */
export function getWeekDays(referenceDate: Date): CalendarDayInfo[] {
  const todayKey = getTodayKey();
  const dayOfWeek = referenceDate.getDay(); // 0 = Sun
  const startOfWeek = new Date(referenceDate);
  startOfWeek.setDate(referenceDate.getDate() - dayOfWeek);

  const days: CalendarDayInfo[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    const dateKey = dateToKey(d);
    days.push({
      dateKey,
      dayNumber: d.getDate(),
      month: d.getMonth(),
      year: d.getFullYear(),
      isCurrentMonth: true,
      isToday: dateKey === todayKey,
      isWeekend: i === 0 || i === 6
    });
  }
  return days;
}

/**
 * Generates a unique content item ID.
 */
export function generateContentId(): string {
  return `item_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Migrates legacy Plan / PLAN_TEMPLATE format to ContentItem[].
 */
export function migrateLegacyPlan(raw: unknown): ContentItem[] {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  if (!raw || typeof raw !== "object") {
    return seedFromTemplate(currentYear, currentMonth);
  }

  const data = raw as Partial<DynamicCalendarStore & Plan>;

  // If already in new ContentItem format
  if (Array.isArray(data.items) && data.items.length > 0) {
    const first = data.items[0];
    if (first && typeof (first as ContentItem).id === "string" && typeof (first as ContentItem).date === "string") {
      return data.items as ContentItem[];
    }

    // Legacy PlanItem array: convert each
    return (data.items as PlanItem[]).map((it, idx) => {
      const day = typeof it.day === "number" ? Math.min(Math.max(1, it.day), 31) : (idx % 30) + 1;
      const dateKey = formatDateKey(currentYear, currentMonth, day);
      return {
        id: `legacy_${it.n || idx + 1}_${Date.now().toString(36)}`,
        n: it.n || idx + 1,
        title: it.topic || `Content #${it.n || idx + 1}`,
        topic: it.topic || "",
        content: it.copy || "",
        platform: it.ch || "Kognoz page",
        contentType: it.fmt || "Carousel",
        date: dateKey,
        time: idx % 2 === 0 ? "10:00" : "15:00",
        status: (it as any).status || "Planned",
        pillar: it.pillar || "Behavioral Signal",
        set: it.set,
        style: it.style,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });
  }

  return seedFromTemplate(currentYear, currentMonth);
}

function seedFromTemplate(year: number, month: number): ContentItem[] {
  return PLAN_TEMPLATE.map((it) => {
    const day = typeof it.day === "number" ? Math.min(Math.max(1, it.day), 30) : 1;
    const dateKey = formatDateKey(year, month, day);
    return {
      id: `seed_${it.n}`,
      n: it.n,
      title: it.topic,
      topic: it.topic,
      content: it.copy,
      platform: it.ch,
      contentType: it.fmt,
      date: dateKey,
      time: it.n % 2 === 0 ? "10:30" : "14:00",
      status: (it as any).status || "Planned",
      pillar: it.pillar,
      set: it.set,
      style: it.style,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  });
}

/**
 * Filter items by query and properties.
 */
export function filterContentItems(
  items: ContentItem[],
  query: string,
  platform: string,
  contentType: string,
  status: string,
  pillar: string
): ContentItem[] {
  const q = query.toLowerCase().trim();
  return items.filter((item) => {
    if (platform && platform !== "all" && item.platform !== platform) return false;
    if (contentType && contentType !== "all" && item.contentType !== contentType) return false;
    if (status && status !== "all" && item.status !== status) return false;
    if (pillar && pillar !== "all" && item.pillar !== pillar) return false;

    if (q) {
      const matchTitle = item.title?.toLowerCase().includes(q);
      const matchTopic = item.topic?.toLowerCase().includes(q);
      const matchContent = item.content?.toLowerCase().includes(q);
      const matchTags = item.tags?.some((t) => t.toLowerCase().includes(q));
      if (!matchTitle && !matchTopic && !matchContent && !matchTags) return false;
    }

    return true;
  });
}

/**
 * The Studio link for a calendar item.
 *
 * This existed three times — in ContentCard, CalendarListView and ContentEditorModal —
 * and the copies had drifted: two opened in the same tab, one in a new one, and the
 * modal built its link from unsaved form state so the link and the stored row disagreed.
 *
 * `n` carries the legacy numeric key when the row has one and the string id otherwise.
 * Studio matches on both, so it must NOT be coerced to a number: Number("item_lz3k9")
 * is NaN, which is why generating from a calendar link never marked the item as Draft.
 */
export function buildStudioHref(item: {
  topic?: string;
  title?: string;
  contentType?: string;
  pillar?: string;
  n?: number;
  id?: string;
  set?: string;
  style?: string;
  /** Whose voice the post is in. The Studio uses it to pick that person's samples. */
  platform?: string;
}): string {
  const p = new URLSearchParams({
    topic: item.topic || item.title || "",
    format: item.contentType || "",
    pillar: item.pillar || "",
    n: item.n != null ? String(item.n) : item.id || "new"
  });
  if (item.set) p.set("set", item.set);
  if (item.style) p.set("style", item.style);
  // The calendar already knows who is publishing. Carrying it across means a
  // deck opened from a calendar item is written in that person's voice rather
  // than defaulting to the company page.
  if (item.platform) p.set("channel", item.platform);
  return `/?${p.toString()}`;
}

/**
 * Step the calendar by one month or one week.
 *
 * `d.setMonth(d.getMonth() + 1)` keeps the day-of-month, so from a 31st it asks for a
 * date the next month does not have and JavaScript rolls it forward: Jan 31 becomes
 * "Feb 31" becomes Mar 3, and February is skipped entirely. Anchoring to the first of
 * the target month is the only way to step months without losing one.
 */
export function stepCalendarDate(prev: Date, delta: number, mode: "month" | "week" | "list"): Date {
  if (mode === "week") {
    const d = new Date(prev);
    d.setDate(d.getDate() + delta * 7);
    return d;
  }
  return new Date(prev.getFullYear(), prev.getMonth() + delta, 1);
}
