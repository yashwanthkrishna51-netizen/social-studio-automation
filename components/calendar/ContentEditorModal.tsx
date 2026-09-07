"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { C, FONT, DISPLAY_FONT, GRAD } from "@/lib/tokens";
import { STUDIO_FORMATS } from "@/lib/formats";
import { buildCaptionPrompt } from "@/lib/promptBuilders";
import { callClaudeText, FAST_MODEL } from "@/lib/claudeClient";
import { storeGet } from "@/lib/storeClient";
import { coerceSamples, pickSamples, type VoiceSample } from "@/lib/voiceSamples";
import { humanizeNote, humanizeText } from "@/lib/humanizePass";
import {
  PLATFORMS,
  PILLARS_LIST,
  PILLAR_COLORS,
  STATUS_CONFIG,
  STATUS_ORDER,
  ALL_CONTENT_TYPES,
  getAuthorInfo,
  type ContentItem,
  type ContentStatus
} from "./types";
import { generateContentId, getTodayKey, buildStudioHref } from "./calendarUtils";

interface ContentEditorModalProps {
  item: ContentItem | null; // null = creating new item
  initialDate?: string;
  isOpen: boolean;
  onClose: () => void;
  /** Resolves false when the save did not reach the server, so the modal can stay open. */
  onSave: (item: ContentItem) => void | Promise<boolean>;
  onDelete?: (id: string) => void;
}

export function ContentEditorModal({
  item,
  initialDate,
  isOpen,
  onClose,
  onSave,
  onDelete
}: ContentEditorModalProps) {
  const { data: session } = useSession();
  const isEditing = !!item;

  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [platform, setPlatform] = useState("LinkedIn");
  const [contentType, setContentType] = useState("Carousel");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [status, setStatus] = useState<ContentStatus>("Planned");
  const [pillar, setPillar] = useState("Behavioral Signal");
  const [content, setContent] = useState("");

  // AI Generation state
  const [aiInstruction, setAiInstruction] = useState("");
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);
  // Replacing a textarea's value from React wipes the browser's native undo stack,
  // so Cmd+Z cannot bring back what the AI overwrote. Without this the only way
  // back to your own words is paying for another generation.
  // A stack, not one slot. With one slot a second rewrite stored the first AI output
  // over the user's own words and the original was gone for good, while the "Undo AI
  // rewrite" button carried on implying it could be recovered.
  const [undoStack, setUndoStack] = useState<string[]>([]);
  // The exact text the last generation produced. Cmd+Z only rewinds while the box
  // still holds it untouched — otherwise the shortcut threw away everything the user
  // had typed since, with no redo, because the controlled value had already wiped the
  // browser's own undo history.
  const [aiOutput, setAiOutput] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const overlayArmed = useRef(false);
  const [aiError, setAiError] = useState("");
  const [passNote, setPassNote] = useState("");
  // House style and the voice corpus are shared server state, loaded once per
  // modal open. Both are small blobs and both go straight into the prompt.
  const [housePrefs, setHousePrefs] = useState("");
  const [voiceSamples, setVoiceSamples] = useState<VoiceSample[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (isOpen) {
      if (item) {
        setTitle(item.title || item.topic || "");
        setTopic(item.topic || item.title || "");
        setPlatform(item.platform || "LinkedIn");
        setContentType(item.contentType || "Carousel");
        setDate(item.date || getTodayKey());
        setTime(item.time || "10:00");
        setStatus(item.status || "Planned");
        setPillar(item.pillar || "Behavioral Signal");
        setContent(item.content || "");
        setUndoStack([]);
        setAiOutput(null);
      } else {
        setTitle("");
        setTopic("");
        setPlatform("LinkedIn");
        setContentType("Carousel");
        setDate(initialDate || getTodayKey());
        setTime("10:00");
        setStatus("Planned");
        setPillar("Behavioral Signal");
        setContent("");
        setUndoStack([]);
        setAiOutput(null);
      }
      setAiInstruction("");
      setAiError("");
      setConfirmDelete(false);
      setConfirmDiscard(false);
      setSaveError("");
    }
  }, [isOpen, item, initialDate]);

  // What the form looked like when it opened, mirroring the initialiser above, so an
  // untouched form closes without a prompt and a touched one never closes silently.
  const pristine = item
    ? {
        title: item.title || item.topic || "",
        topic: item.topic || item.title || "",
        platform: item.platform || "LinkedIn",
        contentType: item.contentType || "Carousel",
        date: item.date || getTodayKey(),
        time: item.time || "10:00",
        status: (item.status || "Planned") as ContentStatus,
        pillar: item.pillar || "Behavioral Signal",
        content: item.content || ""
      }
    : {
        title: "",
        topic: "",
        platform: "LinkedIn",
        contentType: "Carousel",
        date: initialDate || getTodayKey(),
        time: "10:00",
        status: "Planned" as ContentStatus,
        pillar: "Behavioral Signal",
        content: ""
      };

  const isDirty =
    title !== pristine.title ||
    topic !== pristine.topic ||
    platform !== pristine.platform ||
    contentType !== pristine.contentType ||
    date !== pristine.date ||
    time !== pristine.time ||
    status !== pristine.status ||
    pillar !== pristine.pillar ||
    content !== pristine.content;

  // Closing used to discard everything on the spot — including a caption the user had
  // just paid Claude for — on a stray backdrop click.
  const requestClose = useCallback(() => {
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, requestClose]);

  // Load the shared writing context when the modal opens. Failures are silent on
  // purpose: no house style and no samples means a plainer prompt, not a broken
  // caption button.
  useEffect(() => {
    if (!isOpen) return;
    // The modal is hidden rather than unmounted, so a note left over from the
    // last item would otherwise sit above a caption it does not describe.
    setPassNote("");
    let live = true;
    (async () => {
      const [hp, vs] = await Promise.all([
        storeGet<string>("kognoz-house-prefs").then((r) => r.value).catch(() => null),
        storeGet<unknown>("kognoz-voice-samples").then((r) => r.value).catch(() => null)
      ]);
      if (!live) return;
      if (typeof hp === "string") setHousePrefs(hp);
      setVoiceSamples(coerceSamples(vs));
    })();
    return () => {
      live = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  async function handleGenerateAI() {
    // Backstop for the disabled attribute: without this an in-flight request can be
    // fired again by a keyboard activation or a double event, buying a second caption.
    if (isGeneratingAI) return;
    const promptTopic = topic.trim() || title.trim();
    if (!promptTopic) {
      setAiError("Please provide a Title or Topic before generating.");
      return;
    }
    setIsGeneratingAI(true);
    setAiError("");
    try {
      const samples = pickSamples(voiceSamples, { channel: platform, kind: "post" });
      const prompt = buildCaptionPrompt({
        channel: platform,
        fmt: contentType,
        topic: promptTopic,
        currentCopy: content,
        instruction: aiInstruction.trim() || undefined,
        // This argument was simply missing. Every rule the team had added to house
        // style was invisible to caption generation, while the Studio saw all of
        // them — so the two surfaces were being written to different rules.
        housePrefs,
        voiceSamples: samples
      });
      // Haiku for any REWRITE (half the price of sonnet), sonnet only for a caption
      // written from nothing. This previously keyed off whether an instruction was
      // typed, so "Rewrite with AI" with an empty instruction box silently paid
      // sonnet rates to reword copy that already existed.
      const isRewrite = Boolean(content.trim()) || Boolean(aiInstruction.trim());
      const generated = await callClaudeText("caption", prompt, isRewrite ? { model: FAST_MODEL } : undefined);

      // Second pass. Skipped when the team typed an instruction: they asked for a
      // specific change, and a line edit on top would undo the rest of it.
      let next = generated.trim();
      if (aiInstruction.trim()) {
        setPassNote("");
      } else {
        const edited = await humanizeText(next, { voiceSamples: samples, housePrefs, channel: platform });
        next = edited.value.trim();
        setPassNote(humanizeNote(edited));
      }

      setUndoStack((s) => [...s, content]);
      setContent(next);
      setAiOutput(next);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI caption generation failed");
    } finally {
      setIsGeneratingAI(false);
    }
  }

  async function handleSaveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSaving) return;
    const finalTopic = topic.trim() || title.trim() || "Untitled Post";
    const finalTitle = title.trim() || finalTopic;

    const currentAuthorName = item?.authorName || session?.user?.name || session?.user?.email?.split("@")[0] || "Mayank";
    const currentAuthorEmail = item?.authorEmail || session?.user?.email || "";

    const savedItem: ContentItem = {
      id: item?.id || generateContentId(),
      n: item?.n,
      title: finalTitle,
      topic: finalTopic,
      content: content.trim(),
      platform,
      contentType,
      date: date || getTodayKey(),
      time: time || "10:00",
      status,
      pillar,
      authorName: currentAuthorName,
      authorEmail: currentAuthorEmail,
      set: item?.set,
      style: item?.style,
      createdAt: item?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Closing before the write resolved meant a 409 told the user to "redo your
    // change" after the form holding it had already unmounted. Wait for the answer.
    setIsSaving(true);
    setSaveError("");
    try {
      const ok = await onSave(savedItem);
      if (ok === false) {
        setSaveError("That didn't save — your text is still here. Check the message above and try again.");
        return;
      }
      onClose();
    } finally {
      setIsSaving(false);
    }
  }

  const isStudioFmt = (STUDIO_FORMATS as readonly string[]).includes(contentType);

  // Built from what is on screen, so the link carries the topic the user can see —
  // but nothing here is saved, so a dirty form and the stored row will diverge. The
  // button below says so rather than leaving the user to discover it.
  function createStudioHref(): string {
    return buildStudioHref({
      topic: topic || title,
      contentType,
      pillar,
      n: item?.n,
      id: item?.id,
      set: item?.set,
      style: item?.style
    });
  }

  const activeAuthor = getAuthorInfo(
    item?.authorName || session?.user?.name,
    item?.authorEmail || session?.user?.email
  );

  const labelStyle: React.CSSProperties = {
    fontFamily: FONT,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: C.inkMute,
    marginBottom: 6,
    display: "block"
  };

  const inputStyle: React.CSSProperties = {
    fontFamily: FONT,
    fontSize: 13,
    color: C.ink,
    background: "#ffffff",
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    padding: "8px 12px",
    width: "100%",
    boxSizing: "border-box",
    outline: "none"
  };

  return (
    <div
      onMouseDown={(e) => {
        overlayArmed.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // A click is delivered to the nearest common ancestor of mousedown and
        // mouseup, so selecting caption text and releasing outside the dialog used to
        // count as a backdrop click and threw the whole draft away.
        const bothOnBackdrop = overlayArmed.current && e.target === e.currentTarget;
        overlayArmed.current = false;
        if (bothOnBackdrop) requestClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10, 30, 50, 0.45)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#ffffff",
          borderRadius: 16,
          width: "100%",
          maxWidth: 680,
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(0, 30, 60, 0.22)",
          border: `1px solid ${C.line}`,
          padding: "24px 28px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          boxSizing: "border-box"
        }}
      >
        {/* Modal Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.line}`, paddingBottom: 14 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ fontFamily: DISPLAY_FONT, fontSize: 20, color: C.ink, margin: 0 }}>
                {isEditing ? "Edit Content Post" : "Create New Content"}
              </h2>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  background: activeAuthor.bg,
                  color: activeAuthor.color,
                  padding: "2px 8px",
                  borderRadius: 12,
                  fontSize: 11,
                  fontWeight: 700
                }}
              >
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: activeAuthor.color,
                    color: "#fff",
                    fontSize: 8.5,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 800
                  }}
                >
                  {activeAuthor.initial}
                </span>
                {activeAuthor.displayName}
              </span>
            </div>
            <p style={{ fontFamily: FONT, fontSize: 12.5, color: C.inkMute, margin: "3px 0 0 0" }}>
              Schedule, draft, and generate AI-assisted content for your channels.
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            style={{
              background: C.mist,
              border: "none",
              borderRadius: "50%",
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: 16,
              color: C.inkSoft
            }}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSaveSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Title / Topic */}
          <div>
            <label style={labelStyle}>Title / Topic *</label>
            <input
              type="text"
              value={topic}
              onChange={(e) => {
                setTopic(e.target.value);
                if (!title) setTitle(e.target.value);
              }}
              placeholder="e.g. Why internal mobility beats external hiring for scarce AI skills"
              required
              style={{ ...inputStyle, fontSize: 14, fontWeight: 600 }}
            />
          </div>

          {/* Row 1: Platform & Content Type */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label style={labelStyle}>Platform / Channel</label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                style={inputStyle}
              >
                {PLATFORMS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={labelStyle}>Content Type / Format</label>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value)}
                style={inputStyle}
              >
                <optgroup label="Visual Formats (Studio)">
                  {STUDIO_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Text & Interactive Formats">
                  <option value="Text post">Text post</option>
                  <option value="Poll">Poll</option>
                </optgroup>
              </select>
            </div>
          </div>

          {/* Row 2: Date, Time & Status */}
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 14 }}>
            <div>
              <label style={labelStyle}>Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                style={inputStyle}
              />
            </div>

            <div>
              <label style={labelStyle}>Time</label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                style={inputStyle}
              />
            </div>

            <div>
              <label style={labelStyle}>Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as ContentStatus)}
                style={inputStyle}
              >
                {STATUS_ORDER.map((st) => (
                  <option key={st} value={st}>
                    {STATUS_CONFIG[st].label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Row 3: Content Pillar */}
          <div>
            <label style={labelStyle}>Content Pillar</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {PILLARS_LIST.map((p) => {
                const isSelected = pillar === p;
                const col = PILLAR_COLORS[p] || C.blue;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPillar(p)}
                    style={{
                      fontFamily: FONT,
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "6px 12px",
                      borderRadius: 20,
                      border: `1.5px solid ${isSelected ? col : C.line}`,
                      background: isSelected ? col : "#ffffff",
                      color: isSelected ? "#ffffff" : C.inkSoft,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      transition: "all 0.15s ease"
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: isSelected ? "#ffffff" : col
                      }}
                    />
                    {p}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Caption / Content Area + AI Helper */}
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, background: "#FAFCFD" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ ...labelStyle, marginBottom: 0 }}>Caption / Post Copy</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {undoStack.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const prev = undoStack[undoStack.length - 1];
                      setUndoStack((s) => s.slice(0, -1));
                      setContent(prev);
                      setAiOutput(null);
                    }}
                    title="Restore the text the AI replaced (Cmd/Ctrl+Z)"
                    style={{
                      fontSize: 11, fontWeight: 700, color: C.blue, background: "none",
                      border: "none", padding: 0, cursor: "pointer", textDecoration: "underline"
                    }}
                  >
                    Undo AI rewrite
                  </button>
                )}
                <span style={{ fontSize: 11, color: C.inkMute }}>
                  {content.split(/\s+/).filter(Boolean).length} words
                </span>
              </div>
            </div>

            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                // Only intercept while the box still holds the AI output verbatim. Once
                // the user has typed over it, Cmd+Z is theirs: hijacking it discarded
                // every edit made since the generation, with nothing to redo from.
                const untouched = aiOutput !== null && content === aiOutput;
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && untouched && undoStack.length > 0) {
                  e.preventDefault();
                  const prev = undoStack[undoStack.length - 1];
                  setUndoStack((s) => s.slice(0, -1));
                  setContent(prev);
                  setAiOutput(null);
                }
              }}
              rows={5}
              placeholder="Write your post copy here or click 'Generate with Claude' below…"
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, marginBottom: 10 }}
            />

            {/* AI Assistant Sub-bar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 8, borderTop: `1px dashed ${C.line}` }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    // This input sits inside the form, so Enter used to trigger implicit
                    // submission: the post saved and closed, and the instruction the user
                    // had just typed was thrown away without generating anything.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (!isGeneratingAI && topic.trim()) void handleGenerateAI();
                    }
                  }}
                  placeholder="AI Instruction: e.g. Make hook sharper, add 3 bullet points, keep under 120 words…"
                  style={{ ...inputStyle, flex: 1, fontSize: 12 }}
                />
                <button
                  type="button"
                  onClick={handleGenerateAI}
                  disabled={isGeneratingAI || !topic.trim()}
                  style={{
                    fontFamily: FONT,
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#ffffff",
                    background: GRAD,
                    border: "none",
                    borderRadius: 8,
                    padding: "0 14px",
                    cursor: isGeneratingAI || !topic.trim() ? "default" : "pointer",
                    opacity: isGeneratingAI || !topic.trim() ? 0.6 : 1,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0
                  }}
                >
                  <span>⚡</span>
                  <span>{isGeneratingAI ? "Writing…" : content ? "Rewrite with AI" : "Generate with AI"}</span>
                </button>
              </div>
              {aiError && <div style={{ fontSize: 11.5, color: "#B4442E" }}>{aiError}</div>}
              {/* Every caption is written once, then line-edited a second time
                  against real published posts. This says what that pass did. */}
              {!aiError && passNote && <div style={{ fontSize: 11.5, color: C.inkMute }}>{passNote}</div>}
              {!aiError && !passNote && !voiceSamples.length && (
                <div style={{ fontSize: 11.5, color: C.inkMute }}>
                  No voice samples saved yet. Paste real published posts in the Studio sidebar and captions stop reading as machine-written.
                </div>
              )}
            </div>
          </div>

          {/* Modal Footer Actions */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
            <div>
              {isEditing && onDelete && (
                confirmDelete ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "#B4442E", fontWeight: 600 }}>Confirm delete?</span>
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(item.id);
                        onClose();
                      }}
                      style={{
                        background: "#B4442E",
                        color: "#fff",
                        border: "none",
                        borderRadius: 6,
                        padding: "5px 10px",
                        fontSize: 11.5,
                        fontWeight: 700,
                        cursor: "pointer"
                      }}
                    >
                      Yes, Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      style={{
                        background: C.mist,
                        color: C.inkSoft,
                        border: "none",
                        borderRadius: 6,
                        padding: "5px 10px",
                        fontSize: 11.5,
                        cursor: "pointer"
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#B4442E",
                      fontSize: 12.5,
                      fontWeight: 600,
                      cursor: "pointer",
                      padding: "6px 0"
                    }}
                  >
                    🗑 Delete Post
                  </button>
                )
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {isStudioFmt && (
                <a
                  href={createStudioHref()}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontFamily: FONT,
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: C.blue,
                    background: C.mist,
                    padding: "8px 14px",
                    borderRadius: 8,
                    textDecoration: "none"
                  }}
                >
                  Create in Studio →
                </a>
              )}

              <button
                type="button"
                onClick={requestClose}
                style={{
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  color: C.inkSoft,
                  background: "transparent",
                  border: `1px solid ${C.line}`,
                  borderRadius: 8,
                  padding: "8px 16px",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={isSaving}
                style={{
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 700,
                  color: "#ffffff",
                  background: C.blue,
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 20px",
                  cursor: isSaving ? "default" : "pointer",
                  opacity: isSaving ? 0.6 : 1,
                  boxShadow: "0 2px 8px rgba(0, 81, 132, 0.25)"
                }}
              >
                {isSaving ? "Saving…" : isEditing ? "Save Changes" : "Create Post"}
              </button>
            </div>
          </div>

          {saveError && (
            <div style={{ fontSize: 12, color: "#B4442E", fontWeight: 600, marginTop: 10 }}>{saveError}</div>
          )}

          {confirmDiscard && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 8,
                background: "#FFF4E5",
                border: "1px solid #FFD8A8",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap"
              }}
            >
              <span style={{ fontSize: 12.5, color: "#9A5B13" }}>
                You have unsaved changes{undoStack.length > 0 ? ", including AI-written copy" : ""}. Discard them?
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setConfirmDiscard(false)}
                  style={{
                    fontFamily: FONT, fontSize: 12, fontWeight: 700, padding: "6px 12px",
                    borderRadius: 7, border: `1px solid ${C.line}`, background: C.white,
                    cursor: "pointer", color: C.ink
                  }}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={() => { setConfirmDiscard(false); onClose(); }}
                  style={{
                    fontFamily: FONT, fontSize: 12, fontWeight: 700, padding: "6px 12px",
                    borderRadius: 7, border: "none", background: "#B4442E",
                    cursor: "pointer", color: "#fff"
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
