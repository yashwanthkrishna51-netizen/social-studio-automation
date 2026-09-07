"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useSession } from "next-auth/react";
import { storeGet, storeSet } from "@/lib/storeClient";
import { callClaudeJSON } from "@/lib/claudeClient";
import { buildCalendarPlanPrompt } from "@/lib/promptBuilders";
import { coercePlan, toContentItems, occupiedDates, daysInMonth } from "@/lib/calendarPlan";
import { CADENCE } from "@/lib/founderProfiles";
import { coerceSamples, pickSamples } from "@/lib/voiceSamples";
import { humanizeNote, humanizePlanTopics } from "@/lib/humanizePass";
import { generateContentId } from "./calendarUtils";
import { logActivity } from "@/lib/activityClient";
import { C, FONT } from "@/lib/tokens";
import { CalendarHeader } from "./CalendarHeader";
import { CalendarFilters } from "./CalendarFilters";
import { QuickAddBar } from "./QuickAddBar";
import { CalendarMonthView } from "./CalendarMonthView";
import { CalendarWeekView } from "./CalendarWeekView";
import { CalendarListView } from "./CalendarListView";
import { ContentEditorModal } from "./ContentEditorModal";
import {
  type ContentItem,
  type ContentStatus,
  type CalendarViewMode,
  type DynamicCalendarStore
} from "./types";
import {
  migrateLegacyPlan,
  stepCalendarDate,
  filterContentItems,
  formatDateKey,
  dateToKey,
  getTodayKey
} from "./calendarUtils";

const STORAGE_KEY = "kognoz-calendar";

export function CalendarView() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date());
  const [viewMode, setViewMode] = useState<CalendarViewMode>("month");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState("all");
  const [selectedType, setSelectedType] = useState("all");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [selectedPillar, setSelectedPillar] = useState("all");

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalItem, setModalItem] = useState<ContentItem | null>(null);
  const [modalInitialDate, setModalInitialDate] = useState(getTodayKey());

  // Status & persistence states
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  /** The server could not be read. We are NOT looking at a calendar we can trust. */
  const [loadFailed, setLoadFailed] = useState(false);
  const { data: session } = useSession();
  const [planning, setPlanning] = useState(false);
  const [planNote, setPlanNote] = useState("");

  // Mutations read the current items from here rather than from a setState updater.
  // Updaters must be pure: React StrictMode double-invokes them, so a network write
  // inside one fired twice per edit and the two PUTs then conflicted with each other.
  const itemsRef = React.useRef<ContentItem[]>([]);
  // Writes run one after another. Two quick edits used to race, both send the version
  // they read before either landed, and the second came back 409 — telling the user
  // that they themselves had changed the calendar while they were editing.
  const saveChain = React.useRef<Promise<unknown>>(Promise.resolve());

  const applyItems = useCallback((next: ContentItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  /**
   * Load the calendar.
   *
   * On failure this used to seed PLAN_TEMPLATE — a demo calendar — and render it as
   * if it were real. The first edit then persisted that template over the team's
   * actual data. A calendar we could not read is now an error state with a retry,
   * never a guess. `migrateLegacyPlan(null)` still seeds the template on a genuine
   * empty-but-successful read, which is the intended first-run experience.
   */
  const loadCalendar = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { value, stale } = await storeGet<unknown>(STORAGE_KEY);
      if (!stale) {
        applyItems(migrateLegacyPlan(value));
        setLoadFailed(false);
        return;
      }
      let local: unknown = null;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        local = raw ? JSON.parse(raw) : null;
      } catch {
        local = null;
      }
      setLoadFailed(true);
      if (local) {
        applyItems(migrateLegacyPlan(local));
        setError(
          "Showing the copy cached in this browser — the server is unreachable. " +
            "Edits will not be saved until it is back."
        );
      } else {
        applyItems([]);
      }
    } finally {
      setLoading(false);
    }
  }, [applyItems]);

  useEffect(() => {
    void loadCalendar();
  }, [loadCalendar]);

  /**
   * Save to /api/store. Writes are chained so they can never overlap: two edits a
   * moment apart both used to send the version they read before either landed, and
   * the second came back 409 naming the user as their own conflicting editor.
   *
   * Returns whether the write reached the server, so callers (the editor modal) can
   * keep the user's work on screen instead of closing over a failure.
   */
  const persistItems = useCallback(async (nextItems: ContentItem[]): Promise<boolean> => {
    const run = saveChain.current.then(async (): Promise<boolean> => {
      setIsSaving(true);
      const payload: DynamicCalendarStore = {
        version: 3,
        items: nextItems,
        updatedAt: new Date().toISOString()
      };
      try {
        const saved = await storeSet<unknown>(STORAGE_KEY, payload);
        if (saved.ok) {
          setError("");
          return true;
        }
        if (saved.reason === "conflict") {
          // Someone else saved while this tab was editing. Overwriting them is what
          // the old blind PUT did, and it destroyed work silently. Take the server's
          // copy and tell the user their change did not stick.
          applyItems(migrateLegacyPlan(saved.serverValue));
          setError(
            `${saved.updatedBy || "Someone else"} changed the calendar while you were editing. ` +
              `Their version is now shown — please redo your change.`
          );
          return false;
        }
        // "Saved locally, sync pending" was a promise the app could not keep: there
        // is no retry queue, and the next load takes the server's copy. Say what is
        // actually true so the user knows the change is still theirs to protect.
        setError(
          "Could not reach the server — this change exists only in this browser and " +
            "will be lost when you reload. Check your connection and edit again."
        );
        return false;
      } catch (e) {
        console.warn("Failed to persist calendar to server:", e);
        setError(
          "Could not reach the server — this change exists only in this browser and " +
            "will be lost when you reload. Check your connection and edit again."
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    });
    saveChain.current = run.catch(() => undefined);
    return run;
  }, [applyItems]);

  /** Apply a new item list and save it. The single path every mutation goes through. */
  const commit = useCallback(
    (next: ContentItem[]): Promise<boolean> => {
      applyItems(next);
      return persistItems(next);
    },
    [applyItems, persistItems]
  );

  // Filtered items
  const filteredItems = useMemo(() => {
    return filterContentItems(
      items,
      searchQuery,
      selectedPlatform,
      selectedType,
      selectedStatus,
      selectedPillar
    );
  }, [items, searchQuery, selectedPlatform, selectedType, selectedStatus, selectedPillar]);

  // Counts
  const postedCount = useMemo(() => items.filter((i) => i.status === "Posted").length, [items]);

  // Navigation handlers
  function handlePrev() {
    setCurrentDate((prev) => stepCalendarDate(prev, -1, viewMode));
  }

  function handleNext() {
    setCurrentDate((prev) => stepCalendarDate(prev, 1, viewMode));
  }

  function handleToday() {
    setCurrentDate(new Date());
  }

  function handleSelectMonthYear(year: number, month: number) {
    setCurrentDate(new Date(year, month, 1));
  }

  function handleClearFilters() {
    setSearchQuery("");
    setSelectedPlatform("all");
    setSelectedType("all");
    setSelectedStatus("all");
    setSelectedPillar("all");
  }

  // CRUD handlers
  function handleOpenCreateModal(dateKey?: string) {
    setModalItem(null);
    setModalInitialDate(dateKey || dateToKey(currentDate));
    setIsModalOpen(true);
  }

  function handleEditItem(item: ContentItem) {
    setModalItem(item);
    setModalInitialDate(item.date || getTodayKey());
    setIsModalOpen(true);
  }

  // Every calendar change is reported AFTER its save succeeds. Logging optimistically
  // would put edits in the trail that a 409 or a dropped connection then threw away —
  // a record of work that never happened is worse than a gap.
  const track = (
    ok: boolean,
    action: Parameters<typeof logActivity>[0],
    item: ContentItem,
    meta?: Record<string, unknown>
  ) => {
    if (!ok) return;
    logActivity(action, {
      entity: "content",
      entityId: item.id,
      entityLabel: item.title || item.topic,
      screen: "calendar",
      meta: { platform: item.platform, contentType: item.contentType, date: item.date, ...meta }
    });
  };

  function handleSaveItem(savedItem: ContentItem): Promise<boolean> {
    const prev = itemsRef.current;
    const exists = prev.some((it) => it.id === savedItem.id);
    const next = exists
      ? prev.map((it) => (it.id === savedItem.id ? savedItem : it))
      : [savedItem, ...prev];
    // This is the chokepoint for the editor modal's saves, so both creating and
    // editing a post are covered here rather than inside the modal.
    return commit(next).then((ok) => {
      track(ok, exists ? "content_edited" : "content_created", savedItem);
      return ok;
    });
  }

  function handleDeleteItem(id: string) {
    const target = itemsRef.current.find((it) => it.id === id);
    void commit(itemsRef.current.filter((it) => it.id !== id)).then((ok) => {
      if (target) track(ok, "content_deleted", target);
    });
  }

  function handleStatusChange(id: string, nextStatus: ContentStatus) {
    const target = itemsRef.current.find((it) => it.id === id);
    void commit(
      itemsRef.current.map((it) =>
        it.id === id ? { ...it, status: nextStatus, updatedAt: new Date().toISOString() } : it
      )
    ).then((ok) => {
      // The transition to "Posted" is the one people will look for. Worth remembering
      // that it is a status somebody flipped by hand — this app publishes nowhere.
      if (target) track(ok, "content_status_changed", target, { from: target.status, to: nextStatus });
    });
  }

  function handleDropItem(itemId: string, targetDateKey: string) {
    const prev = itemsRef.current;
    const target = prev.find((it) => it.id === itemId);
    if (!target || target.date === targetDateKey) return;
    void commit(
      prev.map((it) =>
        it.id === itemId ? { ...it, date: targetDateKey, updatedAt: new Date().toISOString() } : it
      )
    ).then((ok) => track(ok, "content_edited", target, { movedFrom: target.date, movedTo: targetDateKey }));
  }

  /**
   * Plan the whole month on screen, in one call.
   *
   * The rule that matters: it writes ONLY into empty days. Occupied dates go into the
   * prompt so the model plans around them, and coercePlan drops anything that lands on
   * one anyway — belt and braces, because the calendar has no undo and a button that can
   * overwrite scheduled work is worse than no button.
   */
  async function handlePlanMonth() {
    if (planning) return;
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const monthName = currentDate.toLocaleString("en-GB", { month: "long" });

    const occupied = occupiedDates(itemsRef.current, year, month);
    const last = daysInMonth(year, month);
    // Weekdays only, matching how the team already posts.
    const availableDays: number[] = [];
    for (let d = 1; d <= last; d++) {
      const dow = new Date(year, month, d).getDay();
      if (dow === 0 || dow === 6) continue;
      if (occupied.has(formatDateKey(year, month, d))) continue;
      availableDays.push(d);
    }

    if (!availableDays.length) {
      setPlanNote(`Every weekday in ${monthName} already has a post. Nothing to fill.`);
      return;
    }

    setPlanning(true);
    setPlanNote("");
    setError("");
    try {
      const allSamples = coerceSamples(await storeGet<unknown>("kognoz-voice-samples").then((r) => r.value).catch(() => null));
      // Six rather than the usual four: a month is planned for three different
      // voices in one call, so the corpus shown has to cover all three.
      const planSamples = pickSamples(allSamples, { kind: "post", count: 6 });
      const prompt = buildCalendarPlanPrompt({
        year,
        monthName,
        availableDays,
        // Newest first: the builder keeps only the first 60, and a repeat of last
        // month's subject matters more than a repeat of one from a year ago.
        existingTopics: [...itemsRef.current]
          .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
          .map((i) => i.topic)
          .filter(Boolean),
        // Never ask for more than there are days to put them on.
        targetCount: Math.min(CADENCE.postsPerMonth, availableDays.length * 2),
        voiceSamples: planSamples
      });
      const reply = await callClaudeJSON("calendarPlan", prompt);
      const plan = coercePlan(reply, { year, month, occupied });

      // Second pass, over the topic lines only. Thirty-six topics written in one
      // call converge on a single sentence shape, and every post generated from
      // them inherits it. Only the `topic` string is taken from the reply — days,
      // channels, formats and pillars are copied across untouched, so this cannot
      // reschedule anything. A failure returns the plan unchanged.
      const edited = await humanizePlanTopics(plan.entries, { voiceSamples: planSamples });
      const plannedNote = humanizeNote(edited);
      const stamp = new Date().toISOString();
      const fresh = toContentItems({ ...plan, entries: edited.value }, () => generateContentId(), stamp, {
        name: session?.user?.name,
        email: session?.user?.email
      });

      const ok = await commit([...fresh, ...itemsRef.current]);
      if (ok) {
        logActivity("month_generated", {
          entity: "calendar",
          entityLabel: `${monthName} ${year}`,
          screen: "calendar",
          meta: { count: fresh.length, month: `${year}-${String(month + 1).padStart(2, "0")}` }
        });
        const skipped = plan.skippedOccupied + plan.skippedInvalid;
        setPlanNote(
          `Added ${fresh.length} posts to ${monthName}.` +
            (skipped ? ` ${skipped} were dropped — they landed on days already taken or could not be read.` : "") +
            " Nothing already in the calendar was changed. " +
            plannedNote
        );
      }
    } catch (e) {
      setError(
        `Could not plan ${monthName} (${e instanceof Error ? e.message : e}). Nothing was added — the calendar is unchanged.`
      );
    } finally {
      setPlanning(false);
    }
  }

  function handleQuickAdd(newItem: ContentItem) {
    void commit([newItem, ...itemsRef.current]).then((ok) => track(ok, "content_created", newItem));
  }

  if (loading) {
    return (
      <div style={{ padding: "60px 0", textAlign: "center", fontFamily: FONT, color: C.inkSoft }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
        <div>Loading your content calendar…</div>
      </div>
    );
  }

  // Nothing to show and no way to check what should be there. Previously this
  // rendered the seed template, which looked like a real (wrong) calendar and got
  // written back over the real one on the first edit.
  if (loadFailed && items.length === 0) {
    return (
      <div style={{ padding: "60px 20px", textAlign: "center", fontFamily: FONT, color: C.ink }}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>⚠️</div>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Couldn&apos;t load your calendar</div>
        <div style={{ color: C.inkSoft, fontSize: 13, maxWidth: 420, margin: "0 auto 16px", lineHeight: 1.55 }}>
          The server did not answer. Your calendar is safe — this browser just can&apos;t reach it
          right now. Nothing will be saved until it can.
        </div>
        <button
          type="button"
          onClick={() => void loadCalendar()}
          style={{
            fontFamily: FONT,
            fontSize: 13,
            fontWeight: 700,
            padding: "9px 18px",
            borderRadius: 8,
            border: `1px solid ${C.line}`,
            background: C.white,
            cursor: "pointer",
            color: C.ink
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, fontFamily: FONT }}>
      {/* Saving / Error Banner */}
      {error && (
        <div
          style={{
            padding: "8px 14px",
            background: "#FFF4E5",
            border: "1px solid #FFD8A8",
            borderRadius: 8,
            color: "#9A5B13",
            fontSize: 12.5,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError("")}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: "#9A5B13" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Top Header & Navigation */}
      <CalendarHeader
        currentDate={currentDate}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onPrev={handlePrev}
        onNext={handleNext}
        onToday={handleToday}
        onSelectMonthYear={handleSelectMonthYear}
        onOpenCreateModal={() => handleOpenCreateModal()}
        postedCount={postedCount}
        totalCount={items.length}
      />

      {/* Plan the whole month in one call. Sits above Quick Add because it is the
          coarse tool: fill the month, then hand-add the exceptions. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "10px 14px",
          background: C.white,
          border: `1px solid ${C.line}`,
          borderRadius: 10
        }}
      >
        <button
          type="button"
          onClick={() => void handlePlanMonth()}
          disabled={planning || isSaving}
          title="Plans topics, authors and formats into this month's empty weekdays. Existing posts are never changed."
          style={{
            padding: "8px 16px",
            background: planning ? C.line : C.ink,
            color: planning ? C.inkMute : "#FFF",
            border: "none",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            fontFamily: FONT,
            cursor: planning || isSaving ? "default" : "pointer"
          }}
        >
          {planning ? "Planning the month…" : "✦ Generate this month"}
        </button>
        <span style={{ fontSize: 12, color: C.inkMute, lineHeight: 1.45 }}>
          {planning
            ? "Writing topics for Kognoz, Lokesh and Harpreet — about 30 seconds."
            : "Fills empty weekdays only. Nothing already scheduled is touched."}
        </span>
      </div>

      {planNote && (
        <div
          style={{
            padding: "8px 14px",
            background: "#EAF6EF",
            border: "1px solid #BFE3CD",
            borderRadius: 8,
            color: "#1E6B41",
            fontSize: 12.5,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12
          }}
        >
          <span>{planNote}</span>
          <button
            type="button"
            onClick={() => setPlanNote("")}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: "#1E6B41" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Quick Add Bar */}
      <QuickAddBar
        currentDateKey={dateToKey(currentDate)}
        onAddQuick={handleQuickAdd}
        onOpenFullModal={handleOpenCreateModal}
      />

      {/* Filter Toolbar */}
      <CalendarFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedPlatform={selectedPlatform}
        onPlatformChange={setSelectedPlatform}
        selectedType={selectedType}
        onTypeChange={setSelectedType}
        selectedStatus={selectedStatus}
        onStatusChange={setSelectedStatus}
        selectedPillar={selectedPillar}
        onPillarChange={setSelectedPillar}
        onClearFilters={handleClearFilters}
        totalCount={items.length}
        filteredCount={filteredItems.length}
      />

      {/* Main View Area */}
      {viewMode === "month" && (
        <CalendarMonthView
          year={currentDate.getFullYear()}
          month={currentDate.getMonth()}
          items={filteredItems}
          onAddNew={handleOpenCreateModal}
          onEditItem={handleEditItem}
          onStatusChange={handleStatusChange}
          onDropItem={handleDropItem}
        />
      )}

      {viewMode === "week" && (
        <CalendarWeekView
          currentDate={currentDate}
          items={filteredItems}
          onAddNew={handleOpenCreateModal}
          onEditItem={handleEditItem}
          onStatusChange={handleStatusChange}
          onDropItem={handleDropItem}
        />
      )}

      {viewMode === "list" && (
        <CalendarListView
          items={filteredItems}
          onAddNew={handleOpenCreateModal}
          onEditItem={handleEditItem}
          onStatusChange={handleStatusChange}
          onRewriteAI={handleEditItem}
        />
      )}

      {/* Create / Edit Modal */}
      <ContentEditorModal
        isOpen={isModalOpen}
        item={modalItem}
        initialDate={modalInitialDate}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveItem}
        onDelete={handleDeleteItem}
      />
    </div>
  );
}

export default CalendarView;
