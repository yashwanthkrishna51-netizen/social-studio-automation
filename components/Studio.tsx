// The Studio editor — ported from kognoz-social-studio-v3.jsx's App component
// (state, handlers, and the control-panel/preview JSX structure, lines
// ~915-2143). Adaptations from the reference, each deliberate and noted:
//   - API calls go through lib/claudeClient.ts -> /api/claude (never the raw
//     key; see that file's header comment for why the original couldn't be
//     copied as-is here).
//   - design / house-prefs / style-memory persist to Supabase via /api/store
//     instead of the artifact's window.storage. Same 4 keys, same shape.
//   - The Calendar is a separate route (/calendar) here rather than a
//     toggled `view` state, since this is a multi-page Next.js app, not a
//     single-page artifact. The nav pill is a Link instead of a setView call.
//   - Video recording (recordVideo/MediaRecorder + wrapCanvasText) is NOT
//     ported in this pass — flagged in README as the one remaining gap.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { C, GRAD, FONT, DISPLAY_FONT } from "@/lib/tokens";
import { shiftSlideImages, shiftDeckMap, deckIndexOfSlide, currentAfterRemoval, exportFileCount } from "@/lib/slideIndex";
import { FORMATS, FORMAT_BRIEF, SLIDE_SLOTS, DECK_SLIDE_LIMITS, bodyBudgetFor, type FormatId } from "@/lib/formats";
import { PILLARS } from "@/lib/pillars";
import { DESIGN_SETS, SURFACE_LABELS, surfaceFor, lookLever, nextCardSet, type DesignSetId } from "@/lib/designSets";
import {
  coerceContent,
  applyIdeaDeckKickers,
  applyStatCardHygiene,
  type CoercedSlide
} from "@/lib/coerce";
import {
  MAX_SOURCE_CHARS,
  buildGeneratePrompt,
  buildArticlePrompt,
  buildVerifyPrompt,
  buildModifyPrompt,
  buildDesignNotePrompt,
  type IdeaStyle,
  type StyleExample,
  groundingDefault
} from "@/lib/promptBuilders";
import { callClaudeJSON, callClaudeText, FAST_MODEL } from "@/lib/claudeClient";
import {
  coerceSamples,
  mergeSamples,
  newSample,
  pickSamples,
  samplesFromTemplate,
  SAMPLE_KINDS,
  type SampleKind,
  type VoiceSample
} from "@/lib/voiceSamples";
import { humanizeDeck, humanizeNote, humanizeText } from "@/lib/humanizePass";
import { diffDecks, slideTarget, type EditDiffRow } from "@/lib/editDiff";
import { lintContent } from "@/lib/slopLint";
import { CHANNEL_IDS, type ChannelId } from "@/lib/founderProfiles";
import { storeGet, storeSet, storePeek } from "@/lib/storeClient";
import { exportPdf, exportFramesPdf, exportPanorama, exportStrip, exportPNG, saveBlobAs } from "@/lib/exportPipeline";
import { SocialPreview, type PreviewPage } from "@/components/SocialPreview";
import { ARTICLE_DRAFT_KEY, isWorthSaving, makeDraft, serialiseDraft, parseDraft, sameTopic } from "@/lib/articleDraft";
import { Slide, type SlideDesign, type SlideKind } from "./Slide";
import { Logo } from "./Logo";

const font = FONT;
const displayFont = DISPLAY_FONT;

const SOURCE_KEY = "kognoz-source-material";

const NO_SAMPLES_NOTE =
  "No voice samples saved yet, so this was written with no human writing to imitate. Paste real published posts below.";

interface VerifyCheck {
  where: string;
  claim: string;
  verdict: "verified" | "wrong" | "unverifiable";
  note: string;
  realSource: string | null;
}

const DEFAULT_DESIGN: Required<SlideDesign> = {
  url: "kognozconsulting.com",
  coverRight: "swipe",
  contentRight: "page",
  singleRight: "cta",
  petals: true,
  set: "editorial",
  accent: null
};

const DEFAULT_SLIDES: CoercedSlide[] = [
  { title: "The survey and the behavior disagree", body: "Your engagement score says people own their work. Meanwhile decisions that belong two levels down are landing on your desk for sign-off." },
  { title: "Behavior is the honest data", body: "What people report once a year and what they do every week are different facts. We measure the second one." },
  { title: "The cause is usually structural", body: "Watch the behavior and the problem is rarely attitude. Decision rights, spans, and consequences are set up to push everything upward. Structures can be redesigned." },
  { title: "Read it with the Immersion Index", body: "Five conditions, read through behavioral signals across the organization. You see what is happening and which two changes matter most." }
];

export default function Studio() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();

  const [format, setFormat] = useState<FormatId>("Carousel");
  const [pillar, setPillar] = useState("Behavioral Signal");
  const [topic, setTopic] = useState("");
  const [eyebrow, setEyebrow] = useState("Behavioral Signal");
  const [cover, setCover] = useState("Culture is what your people *do*");
  const [slides, setSlides] = useState<CoercedSlide[]>(DEFAULT_SLIDES);
  const [cta, setCta] = useState("See how we read culture");
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [seed, setSeed] = useState(0);
  const [images, setImages] = useState<Record<string, string | null | undefined>>({});
  const setImg = (key: string, url: string) => setImages((m) => ({ ...m, [key]: url }));
  const [scales, setScales] = useState<Record<number, number>>({});
  const [imgOn, setImgOn] = useState<Record<number, boolean>>({});
  const [ideaStyle, setIdeaStyle] = useState<IdeaStyle>("signals");

  // Web-search grounding is opt-in and visible. It tracks the format/pillar
  // default until the user overrides it, because a grounded generation costs
  // several times a plain one ($10/1000 searches plus every result billed as
  // input tokens) and that should never be an invisible consequence of a
  // format choice.
  const [grounded, setGrounded] = useState(false);
  const groundedTouched = useRef(false);

  const [design, setDesignLocal] = useState<Required<SlideDesign>>(DEFAULT_DESIGN);
  const [housePrefs, setHousePrefsLocal] = useState("");
  const [styleMem, setStyleMem] = useState<StyleExample[]>([]);
  // Real human writing the model imitates. Distinct from styleMem, which is the
  // app's own past output — see lib/voiceSamples.ts for why conflating the two
  // is what made everything sound machine-written.
  const [voiceSamples, setVoiceSamples] = useState<VoiceSample[]>([]);
  const [sampleDraft, setSampleDraft] = useState("");
  const [sampleChannel, setSampleChannel] = useState<ChannelId>("Kognoz page");
  const [sampleKind, setSampleKind] = useState<SampleKind>("post");
  const [showSamples, setShowSamples] = useState(false);
  // Whose voice this deck is in. Captions have always had this; decks did not,
  // so deck copy was written by nobody in particular and could not pick the
  // right person's samples.
  const [channel, setChannel] = useState<ChannelId>("Kognoz page");
  // Notes, a transcript, dictated thoughts. A topic line is not enough material
  // to say anything specific, and generic input is most of why output reads
  // generic. Kept in localStorage so a refresh does not lose a pasted
  // transcript, following the single-slot pattern in lib/articleDraft.ts.
  const [sourceMaterial, setSourceMaterial] = useState("");
  const [showSource, setShowSource] = useState(false);
  // What the edit pass changed, field by field, so a person can keep the
  // original wording of one slide instead of taking the rewrite whole.
  const [editDiff, setEditDiff] = useState<EditDiffRow[] | null>(null);
  // What the second pass did. The score itself is derived below, not stored: a
  // stored score goes stale the moment someone edits a field by hand, and the
  // panel would then be reporting on text that is no longer on screen.
  const [passNote, setPassNote] = useState("");
  const [designNote, setDesignNote] = useState("");
  const [designBusy, setDesignBusy] = useState(false);
  const [lookI, setLookI] = useState(0);

  const [modTxt, setModTxt] = useState("");
  const [modLoading, setModLoading] = useState(false);

  const [article, setArticle] = useState("");
  const [artBusy, setArtBusy] = useState(false);
  const [artInstr, setArtInstr] = useState("");

  // Every AI action here REPLACES what you wrote, and replacing React state wipes the
  // browser's native Cmd+Z stack — so without a snapshot the only way back to your own
  // words is paying for another generation. `undoLabel` names what would be restored.
  type DeckSnapshot = { eyebrow: string; cover: string; slides: CoercedSlide[]; cta: string; label: string };
  const [deckUndo, setDeckUndo] = useState<DeckSnapshot | null>(null);
  const [articleUndo, setArticleUndo] = useState<{ text: string; label: string } | null>(null);

  const snapshotDeck = (label: string) => setDeckUndo({ eyebrow, cover, slides, cta, label });
  const restoreDeck = () => {
    if (!deckUndo) return;
    setEyebrow(deckUndo.eyebrow);
    setCover(deckUndo.cover);
    setSlides(deckUndo.slides);
    setCta(deckUndo.cta);
    setDeckUndo(null);
    bumpReplay();
    // The verdicts describe text that is no longer on screen. Leaving "Apply
    // corrections" live against them let one click silently undo the undo.
    markVerifyStale();
  };

  // A regenerate used to silently delete the article and verify pass the user had
  // already paid for, forcing them to buy both again. Keep them, flag them stale.
  // Content is written FOR a format. Switching afterwards used to leave Carousel copy
  // sitting in a Story frame with no signal at all; now it says so.
  const [staleFormat, setStaleFormat] = useState(false);
  const [staleArticle, setStaleArticle] = useState(false);
  /** The topic a restored draft was written for, so a mismatch can be spotted later. */
  const [draftTopic, setDraftTopic] = useState<string | null>(null);
  const [staleVerify, setStaleVerify] = useState(false);

  // Called whenever the deck changes underneath a completed fact-check. The verdicts
  // were about the OLD text, and "Apply corrections" would write that old text back.
  const markVerifyStale = () => {
    setVerifyFixed(null);
    setStaleVerify(true);
  };

  const [verifying, setVerifying] = useState(false);
  const [verifyRes, setVerifyRes] = useState<VerifyCheck[] | null>(null);
  const [verifyFixed, setVerifyFixed] = useState<{ eyebrow: string; cover: string; slides: CoercedSlide[]; cta: string } | null>(null);

  // One flag for every download path. Without it a second click started a second
  // interleaved run writing the same filenames.
  const [exportBusy, setExportBusy] = useState(false);
  // Replaying the kinetic video. A CSS animation only runs when its element mounts,
  // so replacing the copy re-rendered the same nodes and the sequence never played
  // again — switching format and back was the only way to see it. Bumped wherever the
  // deck is replaced wholesale.
  const [replay, setReplay] = useState(0);
  const bumpReplay = () => setReplay((r) => r + 1);
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Seeded from the cover, since that is the hook, and overwritten by the calendar
  // item's own caption when we arrived from one. Free text after that.
  const [previewCaption, setPreviewCaption] = useState("");
  const captionTouched = useRef(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlVal, setUrlVal] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);

  const [pdfBusy, setPdfBusy] = useState(0);

  // Collapsible sidebar state (persisted across sessions)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [winW, setWinW] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("studio-sidebar-collapsed");
      if (saved === "true") setSidebarCollapsed(true);
    } catch {}

    const handleResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("studio-sidebar-collapsed", String(next));
      } catch {}
      return next;
    });
  };

  // Load shared design/house-prefs/style-memory once on mount (PRD §3.2).
  useEffect(() => {
    (async () => {
      const [d, hp, sm, vs] = await Promise.all([
        storeGet<Partial<SlideDesign>>("kognoz-design").then((r) => r.value),
        storeGet<string>("kognoz-house-prefs").then((r) => r.value),
        storeGet<StyleExample[]>("kognoz-style-memory").then((r) => r.value),
        storeGet<unknown>("kognoz-voice-samples").then((r) => r.value)
      ]);
      if (d && Object.keys(d).length) setDesignLocal((cur) => ({ ...cur, ...d }));
      if (typeof hp === "string") setHousePrefsLocal(hp);
      if (Array.isArray(sm)) setStyleMem(sm);
      const samples = coerceSamples(vs);
      setVoiceSamples(samples);
      // Until real posts are in here, every draft is written with no human
      // writing to imitate, which is the whole point of the feature. An empty
      // corpus should not be a small red line inside a collapsed panel.
      if (!samples.length) setShowSamples(true);
    })();
  }, []);

  const saveDesign = (next: Required<SlideDesign>) => {
    setDesignLocal(next);
    storeSet("kognoz-design", next);
  };
  /**
   * Same, but derived from the newest design rather than the one captured in a closure.
   * Two effects race on mount — one loads the stored design, one applies `?set=` from a
   * calendar link — and the closure form let the loser overwrite the winner with
   * DEFAULT_DESIGN, taking the team's saved website line, accent and motif with it.
   */
  const setDesignAndPersist = (fn: (d: Required<SlideDesign>) => Required<SlideDesign>) => {
    setDesignLocal((d) => {
      const next = fn(d);
      storeSet("kognoz-design", next);
      return next;
    });
  };
  const saveHousePrefs = (v: string) => {
    setHousePrefsLocal(v);
    storeSet("kognoz-house-prefs", v);
  };
  const appendPref = (t: string) => {
    const line = "- " + t.trim();
    if (!t.trim()) return;
    // Both of these used to return silently, so the button looked live and did nothing.
    const existing = housePrefs.split("\n").filter(Boolean);
    if (existing.some((l) => l.trim() === line)) {
      setError("That rule is already in your house style.");
      return;
    }
    if (existing.length >= 12) {
      setError("House style is full at 12 rules — remove one below before adding another.");
      return;
    }
    setError("");
    saveHousePrefs((housePrefs ? housePrefs + "\n" : "") + line);
  };
  /**
   * Save the deck on screen as a STRUCTURAL reference for future generations.
   *
   * This used to fire automatically on every PNG export, and the prompt then told
   * the model to "match their voice" against it. Exporting is not approval, and
   * the saved text is the app's own machine writing, so each generation was
   * imitating the previous one's voice — six slots deep, compounding. That is the
   * single largest reason the output read as AI.
   *
   * It is now an explicit button, and the prompt block it feeds says plainly that
   * these are machine-written and are for slide count and field length only. Voice
   * comes from voiceSamples, which is human writing.
   */
  const saveStyleExample = () => {
    const ex: StyleExample = { format, cover, slides: slides.slice(0, 6), cta };
    const next = [...styleMem.filter((e) => e.cover !== cover), ex].slice(-6);
    setStyleMem(next);
    storeSet("kognoz-style-memory", next);
  };

  // Restore any pasted transcript on mount. localStorage rather than the shared
  // store: this is one person's working notes, not team state.
  useEffect(() => {
    try {
      const v = localStorage.getItem(SOURCE_KEY);
      if (v) {
        setSourceMaterial(v);
        setShowSource(true);
      }
    } catch {
      /* private mode or quota — the field just starts empty */
    }
  }, []);

  const saveSourceMaterial = (v: string) => {
    setSourceMaterial(v);
    try {
      if (v.trim()) localStorage.setItem(SOURCE_KEY, v);
      else localStorage.removeItem(SOURCE_KEY);
    } catch {
      /* not worth an error banner; the value is still in state for this session */
    }
  };

  /**
   * Switch one field between the pass-one wording and the edited wording.
   *
   * Writes through the same setters the manual editors use, so the undo snapshot
   * and the verify-staleness flag behave exactly as they do for a hand edit.
   */
  const useWording = (key: string, which: "edited" | "original") => {
    const row = (editDiff || []).find((r) => r.key === key);
    if (!row || row.using === which) return;
    const text = which === "edited" ? row.edited : row.original;

    if (key === "cover") setCover(text);
    else if (key === "cta") setCta(text);
    else {
      const target = slideTarget(key);
      if (target) updSlide(target.index, target.field, text);
    }
    setEditDiff((rows) => (rows || []).map((r) => (r.key === key ? { ...r, using: which } : r)));
    bumpReplay();
    markVerifyStale();
  };

  const revertEditPass = () => {
    for (const row of editDiff || []) useWording(row.key, "original");
  };

  const persistSamples = (next: VoiceSample[]) => {
    setVoiceSamples(next);
    storeSet("kognoz-voice-samples", next);
  };

  const addSample = () => {
    const text = sampleDraft.trim();
    if (!text) return;
    if (text.length < 140) {
      setError("That is too short to teach a voice. Paste the whole post, not a line from it.");
      return;
    }
    if (voiceSamples.some((v) => v.text.trim() === text)) {
      setError("That sample is already saved.");
      return;
    }
    setError("");
    persistSamples([...voiceSamples, newSample({ channel: sampleChannel, kind: sampleKind, text })]);
    setSampleDraft("");
  };

  const removeSample = (id: string) => persistSamples(voiceSamples.filter((v) => v.id !== id));

  const importTemplateSamples = () => {
    const next = mergeSamples(voiceSamples, samplesFromTemplate());
    if (next.length === voiceSamples.length) {
      setError("Those are already imported.");
      return;
    }
    setError("");
    persistSamples(next);
  };

  const updSlide = (i: number, key: "title" | "body", val: string) =>
    setSlides((s) => s.map((x, j) => (j === i ? { ...x, [key]: val } : x)));
  const addSlide = () =>
    setSlides((s) => (s.length >= slideCap ? s : [...s, { title: "New point", body: "One clear idea for this slide." }]));

  // See lib/slideIndex.ts for why these three maps have to move together.
  const rmSlide = (i: number) => {
    if (slides.length <= 1) return;
    const deckIdx = deckIndexOfSlide(i, Boolean(fmt.deck));
    setSlides((s) => s.filter((_, j) => j !== i));
    setImages((m) => shiftSlideImages(m, i));
    setScales((m) => shiftDeckMap(m, deckIdx));
    setImgOn((m) => shiftDeckMap(m, deckIdx));
    setCurrent((c) => currentAfterRemoval(c, deckIdx));
  };

  const selectDeck = (i: number) => setCurrent(Math.max(0, Math.min(i, deck.length - 1)));

  const selectFormat = (f: FormatId) => {
    if (f === format) return;
    // Only stale if there is real generated content to mismatch — the seeded default
    // deck is not worth warning about.
    if (slides !== DEFAULT_SLIDES) setStaleFormat(true);
    setFormat(f);
    setCurrent(0);
    // Photo intent must not travel between formats. `imgOn` is keyed by DECK index, and
    // index 0 is the cover on a deck but the whole asset on a single format — so turning
    // a photo on for Story left Carousel opening with an empty "Add cover photo" slot on
    // a format the user never touched. `images` is deliberately kept: those keys are
    // format-specific apart from "cover", and dropping an imported picture on a format
    // switch would be worse than the bug being fixed.
    setImgOn({});
  };

  // Anything that changes what the model was asked for must be inert while it is
  // being asked: the in-flight closure writes the OLD format's content and then calls
  // setStaleFormat(false), so a mid-flight switch produced Carousel copy in a Story
  // frame with the mismatch warning explicitly suppressed.
  const busy = loading || modLoading;

  // A restored draft written for a different topic than the one now in the box. Derived
  // rather than stored: the topic can arrive after the draft does (a calendar link), so a
  // value computed once on mount would always say "no mismatch".
  const draftTopicMismatch = Boolean(article && draftTopic && topic.trim() && !sameTopic(draftTopic, topic));

  /**
   * The automated style check, recomputed from whatever is on screen.
   *
   * Derived rather than stored so a hand edit updates it immediately: a score
   * captured at generation time would keep describing text the user has since
   * rewritten. Pure and cheap — regex passes over a few hundred characters.
   */
  const styleReport = useMemo(
    () => (cover || slides.length ? lintContent({ cover, slides, cta }) : null),
    [cover, slides, cta]
  );

  const accent = design.accent || PILLARS[pillar] || C.blue;
  const fmt = FORMATS[format];
  // How many slides THIS format will actually draw. Single-asset renderers read a
  // fixed number and silently ignore the rest, so the editor must not offer more.
  const slideCap = fmt.deck ? DECK_SLIDE_LIMITS.max : fmt.single ? SLIDE_SLOTS[fmt.single] : 1;
  const atCap = slides.length >= slideCap;
  const baseW = fmt.w;
  const baseH = fmt.h;
  const isMobile = winW < 768;
  const maxAvailW = Math.max(260, isMobile ? winW - 32 : sidebarCollapsed ? winW - 48 : winW - 440);
  const idealW = baseW > 2000
    ? (sidebarCollapsed ? 1080 : 780)
    : baseW > baseH
    ? (sidebarCollapsed ? 860 : 620)
    : baseH > 1500
    ? (sidebarCollapsed ? 440 : 330)
    : (sidebarCollapsed ? 540 : 400);

  const previewW = Math.min(idealW, maxAvailW);
  const previewScale = previewW / baseW;

  type DeckItem = { kind: SlideKind } & Partial<CoercedSlide>;
  const deck: DeckItem[] = fmt.deck
    ? [{ kind: "cover" }, ...slides.map((s) => ({ kind: "content" as SlideKind, ...s })), { kind: "end" }]
    : [{ kind: (fmt.single as SlideKind) || "cover" }];
  const total = slides.length;
  const cur = deck[Math.min(current, deck.length - 1)];

  // `cur` is clamped for display, but the raw `current` is what the export node id,
  // the text-scale map and the photo-toggle map are keyed on. Keep the real value in
  // range so those three never disagree with what is on screen.
  useEffect(() => {
    setCurrent((c) => (c > deck.length - 1 ? deck.length - 1 : c));
  }, [deck.length]);

  useEffect(() => {
    if (!groundedTouched.current) setGrounded(groundingDefault(format, pillar));
  }, [format, pillar]);

  // Cmd/Ctrl+Z restores the last thing an AI action replaced. Inside a text field the
  // browser's own undo is the right behaviour, so leave those alone.
  // restoreDeck is re-created every render, so listing it as a dependency tore the
  // listener down and rebuilt it on every keystroke in every textarea on the page.
  const undoRef = useRef<{ restore: () => void; can: boolean; busy: boolean }>({ restore: () => {}, can: false, busy: false });
  undoRef.current = { restore: restoreDeck, can: Boolean(deckUndo), busy };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      if (el?.isContentEditable) return;
      // Undoing into a generation that is about to overwrite the result is not an undo.
      if (!undoRef.current.can || undoRef.current.busy) return;
      e.preventDefault();
      undoRef.current.restore();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The caption follows the cover until the user edits it, so opening the preview on
  // a fresh deck shows something real rather than an empty box.
  useEffect(() => {
    // The cover carries *emphasis* markers for the renderer; a caption is plain text.
    if (!captionTouched.current) setPreviewCaption(String(cover || "").replace(/\*/g, ""));
  }, [cover]);

  /**
   * The article is the one expensive thing in the app a refresh used to destroy: it was
   * component state only, so a reload lost a 900-1200 word piece that cost about $0.02.
   * localStorage rather than /api/store on purpose — the store blobs are shared team-wide,
   * and a half-written draft belongs to the person writing it.
   */
  const saveArticleDraft = (text: string) => {
    if (typeof window === "undefined") return;
    try {
      if (!isWorthSaving(text)) {
        localStorage.removeItem(ARTICLE_DRAFT_KEY);
        return;
      }
      localStorage.setItem(ARTICLE_DRAFT_KEY, serialiseDraft(makeDraft(topic, pillar, text, new Date().toISOString())));
    } catch {
      /* private mode or quota — the draft is still on screen, which is the common case */
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(ARTICLE_DRAFT_KEY);
    } catch {
      return;
    }
    const draft = parseDraft(raw);
    if (!draft) return;
    setArticle(draft.text);
    // Only record WHICH topic it was written for. Deciding staleness here would compare
    // against an empty topic every time: this runs on mount, and the calendar priming
    // effect that puts ?topic= into state has not run yet. The comparison is derived at
    // render instead, so it settles whenever the topic does.
    setDraftTopic(draft.topic);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once, on mount
  }, []);

  async function markDrafted(itemN: number | string) {
    // Calendar Create-> sets the item to Draft on successful generation
    // Round-trips through /api/store since Studio doesn't hold calendar state directly.
    const { value: plan } = await storeGet<{ items: { id?: string; n?: number; status: string }[] }>("kognoz-calendar");
    if (!plan || !Array.isArray(plan.items)) return;
    const next = {
      ...plan,
      items: plan.items.map((it) => {
        const matches = it.id === String(itemN) || (typeof it.n === "number" && it.n === Number(itemN));
        return matches ? { ...it, status: "Draft" } : it;
      })
    };
    const saved = await storeSet("kognoz-calendar", next);
    if (!saved.ok && saved.reason === "conflict") {
      // Someone edited the calendar while this deck was generating. Marking one
      // item as Draft is not worth overwriting their work — say so and move on.
      setError("Generated, but the calendar was changed by someone else, so its status was not updated.");
    }
  }

  async function generate(
    tTopic?: string,
    tPillar?: string,
    tFormat?: FormatId,
    itemN?: number | string | null,
    fresh?: boolean,
    tGrounded?: boolean
  ) {
    const gTopic = typeof tTopic === "string" ? tTopic : topic;
    const gPillar = typeof tPillar === "string" && tPillar ? tPillar : pillar;
    const gFormat = typeof tFormat === "string" && tFormat ? tFormat : format;
    // Explicit param wins: on the autorun path the `grounded` state set moments ago
    // has not committed yet, and reading it from the closure would silently ground
    // (or fail to ground) against the user's actual choice.
    const gGrounded = typeof tGrounded === "boolean" ? tGrounded : grounded;
    if (!gTopic.trim() || loading || modLoading) return;
    setLoading(true);
    setError("");
    // Clear before the call, not after: a failed generation would otherwise leave
    // the previous deck's edit-pass note sitting under the new topic.
    setPassNote("");
    setEditDiff(null);
    try {
      // Chosen once and used for both passes, so the draft and the line edit are
      // measured against the same writing.
      // Channel first: with a voice chosen, pickSamples prefers that person's
      // writing and falls back to their posts when no slide samples exist.
      const samples = pickSamples(voiceSamples, { channel, kind: "slide", seed });
      const { system, user, useSearch } = buildGeneratePrompt({
        topic: gTopic,
        pillar: gPillar,
        format: gFormat,
        ideaStyle,
        housePrefs,
        styleMem,
        voiceSamples: samples,
        channel,
        sourceMaterial,
        seed,
        fresh,
        grounded: gGrounded
      });
      const bodyBudget = bodyBudgetFor(gFormat);
      // Per-format body budget: without it, a Story asking for three paragraphs gets
      // cut to 230 characters on arrival and the page looks unchanged.
      const parsed = coerceContent(await callClaudeJSON("generate", { system, user }, { useSearch }), undefined, {
        body: bodyBudget
      });
      if (gFormat === "Idea Deck") parsed.slides = applyIdeaDeckKickers(parsed.slides, ideaStyle);
      if (gFormat === "Stat Card" && parsed.slides[0]) parsed.slides[0] = applyStatCardHygiene(parsed.slides[0]);

      // Second pass: the line edit. It never throws — a failure returns the draft
      // untouched, because the draft is already paid for and already usable.
      // No source material here on purpose: the edit pass freezes every fact in
      // the draft, and handing it new material would invite claims nobody
      // reviewed onto the slides.
      const edited = await humanizeDeck(parsed, { voiceSamples: samples, housePrefs, channel });
      setPassNote(voiceSamples.length ? humanizeNote(edited) : NO_SAMPLES_NOTE);

      // Back through the quality firewall: the edit pass is a model reply like any
      // other and must not be trusted with URLs, dashes or character budgets.
      const final = coerceContent(edited.value, parsed.slides.length, { body: bodyBudget });
      if (gFormat === "Idea Deck") final.slides = applyIdeaDeckKickers(final.slides, ideaStyle);
      if (gFormat === "Stat Card" && final.slides[0]) final.slides[0] = applyStatCardHygiene(final.slides[0]);

      // Diff the two COERCED versions. Comparing the raw model reply against the
      // coerced draft would report the quality firewall's own edits — clamped
      // lengths, stripped URLs, capitalised lines — as though the editor made them.
      setEditDiff(edited.applied ? diffDecks(parsed, final) : null);

      setEyebrow(gPillar);
      setCover(final.cover);
      setSlides(final.slides);
      setCta(final.cta || "Start the conversation");
      bumpReplay();
      setImages({});
      setScales({});
      setImgOn({});
      snapshotDeck("previous deck");
      setStaleFormat(false);
      setStaleArticle(Boolean(article));
      if (verifyRes || verifyFixed) markVerifyStale();
      setCurrent(0);
      if (itemN != null) markDrafted(itemN);
    } catch (e) {
      const why = e instanceof Error && e.message ? ` (${e.message})` : "";
      setError(`Couldn't generate this time${why} — you can edit the content by hand below, or try again.`);
    } finally {
      setLoading(false);
    }
  }

  const startFresh = () => {
    if (!topic.trim() || loading || modLoading) return;
    setSeed(seed + 1 + Math.floor(Math.random() * 7)); // new layout deal, not just +1
    setImages({});
    setModTxt("");
    setError("");
    setCurrent(0);
    generate(topic, pillar, format, null, true, grounded);
  };

  async function modifyContent() {
    if (!modTxt.trim() || modLoading || loading) return;
    setModLoading(true);
    setError("");
    try {
      const prompt = buildModifyPrompt({ eyebrow, cover, slides, cta, instruction: modTxt, housePrefs });
      const parsed = coerceContent(await callClaudeJSON("revise", prompt, { model: FAST_MODEL }), undefined, {
        body: bodyBudgetFor(format)
      });
      snapshotDeck("revision");
      setEyebrow(parsed.eyebrow || eyebrow);
      setCover(parsed.cover || cover);
      setSlides(parsed.slides);
      setCta(parsed.cta || cta);
      setModTxt("");
      bumpReplay();
      markVerifyStale();
    } catch {
      setError("Couldn't revise this time. Try again, or edit the fields directly.");
    } finally {
      setModLoading(false);
    }
  }

  async function writeArticle(instruction?: string) {
    if (artBusy || loading || !topic.trim()) return;
    setArtBusy(true);
    setError("");
    try {
      const samples = pickSamples(voiceSamples, { kind: "article", seed });
      const prompt = buildArticlePrompt({ topic, pillar, instruction, currentArticle: article, voiceSamples: samples, seed });
      const text = await callClaudeText("article", prompt, { model: instruction && instruction.trim() ? FAST_MODEL : undefined, maxTokens: 2600 });

      // Second pass. Skipped on a targeted revision: the team asked for one
      // specific change, and a line edit on top of it would quietly rewrite the
      // rest of a piece they had already approved.
      let finalText = text.trim();
      if (instruction && instruction.trim()) {
        setPassNote("");
      } else {
        const edited = await humanizeText(finalText, { voiceSamples: samples, maxTokens: 6000 });
        finalText = edited.value.trim();
        setPassNote(humanizeNote(edited));
      }

      setArticleUndo(article ? { text: article, label: instruction?.trim() ? "revision" : "rewrite" } : null);
      setArticle(finalText);
      saveArticleDraft(finalText);
      setDraftTopic(topic);
      setStaleArticle(false);
      setArtInstr("");
    } catch (e) {
      setError(`Article writing failed (${e instanceof Error ? e.message : e}). Try once more; tell me this message if it repeats.`);
    } finally {
      setArtBusy(false);
    }
  }

  async function verifyFacts() {
    if (verifying || loading || modLoading) return;
    setVerifying(true);
    setError("");
    setVerifyRes(null);
    setVerifyFixed(null);
    try {
      const prompt = buildVerifyPrompt({ eyebrow, cover, slides, cta });
      const parsed = await callClaudeJSON("verify", prompt, { useSearch: true });
      if (parsed && parsed.fixed) {
        setVerifyRes(parsed.checks || []);
        setVerifyFixed(parsed.fixed);
        setStaleVerify(false);
      } else {
        throw new Error("no verdicts returned");
      }
    } catch (e) {
      setError(`Fact check failed (${e instanceof Error ? e.message : e}). Try once more.`);
    } finally {
      setVerifying(false);
    }
  }
  function applyVerified() {
    if (!verifyFixed) return;
    const parsed = coerceContent(verifyFixed);
    snapshotDeck("fact-check fixes");
    setEyebrow(parsed.eyebrow || eyebrow);
    setCover(parsed.cover || cover);
    setSlides(parsed.slides && parsed.slides.length ? parsed.slides : slides);
    setCta(parsed.cta || cta);
    bumpReplay();
    setVerifyRes(null);
    setVerifyFixed(null);
  }

  async function applyDesignNote() {
    if (!designNote.trim() || designBusy || loading) return;
    setDesignBusy(true);
    setError("");
    try {
      const prompt = buildDesignNotePrompt(designNote);
      const parsed = await callClaudeJSON("designNote", prompt, { model: FAST_MODEL });
      const next = { ...design };
      if (typeof parsed.url === "string" && parsed.url.trim()) next.url = parsed.url.trim();
      if (["swipe", "url", "none"].includes(parsed.coverRight)) next.coverRight = parsed.coverRight;
      if (["page", "url", "none"].includes(parsed.contentRight)) next.contentRight = parsed.contentRight;
      if (["cta", "url", "none"].includes(parsed.singleRight)) next.singleRight = parsed.singleRight;
      if (typeof parsed.petals === "boolean") next.petals = parsed.petals;
      if (["editorial", "numeral", "dark", "glass", "bloom", "magazine", "mixed"].includes(parsed.set)) next.set = parsed.set;
      saveDesign(next);
      setDesignNote("");
    } catch {
      setError("Couldn't read that design note. The toggles below always work.");
    } finally {
      setDesignBusy(false);
    }
  }

  const LOOK_SETS: DesignSetId[] = ["editorial", "numeral", "dark", "glass", "bloom", "magazine"];
  const LOOK_ACCENTS: (string | null)[] = [null, C.blue, C.teal, C.cyan, C.green];

  // Which dimension THIS format can actually render. Cycling a design set on a
  // format that has no way to express one is why the button looked broken on
  // Idea Deck, Stat Card, Says vs Does, Montage and Founder Video.
  const lever = lookLever(fmt);

  const cycleLook = () => {
    const i = lookI + 1;
    setLookI(i);

    if (lever === "accent") {
      // Idea Deck / Founder Video show only the accent. Step it every click
      // instead of once every six, which is what made them feel dead.
      const nextAccent = LOOK_ACCENTS[i % LOOK_ACCENTS.length];
      saveDesign({ ...design, accent: nextAccent });
      setSeed((x) => x + 1);
      bumpReplay();
      return;
    }

    if (lever === "cards") {
      // Every set now renders its own surface on these formats, so a plain walk
      // through the sets gives a visibly different look each click. "Mixed" is an
      // explicit choice and rotates surfaces on the seed instead.
      const nextSet: DesignSetId = design.set === "mixed" ? "mixed" : nextCardSet(i);
      const nextAccent = LOOK_ACCENTS[i % LOOK_ACCENTS.length];
      saveDesign({ ...design, set: nextSet, accent: nextAccent });
      setSeed((x) => x + 1);
      bumpReplay();
      return;
    }

    // 6 sets x 5 accents = 30 uniform looks: the set steps every click, the accent once
    // the sets have been round. On "Mixed" the user has pinned the set, so that first
    // half cannot move and the accent stepping only every sixth click left most clicks
    // riding on the seed alone. Step the accent every click there instead.
    const isMixed = design.set === "mixed";
    const nextSet: DesignSetId = isMixed ? "mixed" : LOOK_SETS[i % LOOK_SETS.length];
    const nextAccent = isMixed
      ? LOOK_ACCENTS[i % LOOK_ACCENTS.length]
      : LOOK_ACCENTS[Math.floor(i / LOOK_SETS.length) % LOOK_ACCENTS.length];
    saveDesign({ ...design, set: nextSet, accent: nextAccent });
    setSeed((x) => x + 1);
    // A new look should play in, not cut to the end of a sequence already finished.
    bumpReplay();
  };

  /**
   * Which image slot the URL importer writes to.
   *
   * Montage takes ONE wide picture spanning all three frames, not one per frame: the
   * strip is posted as a continuous piece, and a single image panned across three
   * swipes is what makes it read that way. Three unrelated pictures fought it.
   */
  const photoKeyFor = (): string | null => {
    if (fmt.single === "story") return "story";
    if (fmt.single === "article") return "article";
    if (fmt.single === "montage") return "montage";
    if (fmt.deck && !fmt.idea && cur.kind === "cover") return "cover";
    if (fmt.deck && !fmt.idea && cur.kind === "content") return `s${current - 1}`;
    return null;
  };
  async function importImageUrl() {
    const key = photoKeyFor();
    if (!key || !urlVal.trim() || urlBusy) return;
    setUrlBusy(true);
    setError("");
    try {
      const res = await fetch(urlVal.trim());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!/^image\//.test(blob.type)) throw new Error("that URL isn't an image");
      const dataUrl = await new Promise<string>((resv, rej) => {
        const r = new FileReader();
        r.onload = () => resv(r.result as string);
        r.onerror = () => rej(new Error("read failed"));
        r.readAsDataURL(blob);
      });
      setImg(key, dataUrl);
      // The slot is gated on the photo toggle, so importing without this put the
      // picture in state and left the canvas unchanged — indistinguishable from a
      // failed import.
      setImgOn((m) => ({ ...m, [current]: true }));
      setUrlVal("");
      setUrlOpen(false);
    } catch (e) {
      setError(
        `Couldn't import that image (${e instanceof Error ? e.message : e}). Many sites block cross-site fetches; download the picture and click the photo area to upload it instead. Unsplash links (images.unsplash.com) import cleanly.`
      );
    } finally {
      setUrlBusy(false);
    }
  }

  const bumpScale = (d: number) =>
    setScales((m) => {
      const c = m[current] || 1;
      const next = Math.min(1.5, Math.max(0.6, Math.round((c + d) * 100) / 100));
      return { ...m, [current]: next };
    });

  // -------------------- export handlers --------------------
  const elIds = deck.map((_, i) => `exp-${i}`);
  // Anything that is genuinely a multi-page document: the decks, and Montage, whose
  // one wide canvas is posted as `frames` separate slides.
  const docCapable = Boolean(fmt.deck || fmt.frames);
  const docPages = fmt.frames || deck.length;
  const pngFiles = exportFileCount(deck.length, fmt.frames);
  // The same per-page bundle the hidden export copies get, so the feed preview shows
  // the identical artwork rather than a second interpretation of it.
  const previewPages: PreviewPage[] = deck.map((d, i) => ({
    kind: d.kind,
    data: d as CoercedSlide,
    idx: d.kind === "content" ? i : 0,
    scale: scales[i] || 1,
    photoOn: !!imgOn[i]
  }));
  const filenameBase = (i: number) => `kognoz-${format.toLowerCase().replace(/\s+/g, "-")}-${String(i + 1).padStart(2, "0")}`;

  /** Export one slide. Returns the failure text, or null on success. */
  async function exportOne(i: number): Promise<string | null> {
    try {
      await exportPNG({ elId: `exp-${i}`, baseW, baseH, frames: fmt.frames, filenameBase: filenameBase(i) });
      return null;
    } catch (e) {
      return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }

  async function handleExportPNG(i: number) {
    if (exportBusy) return;
    setExportBusy(true);
    setError("");
    try {
      const failure = await exportOne(i);
      if (failure) {
        setError(
          `Export failed (${failure}). Tap download once more; if it repeats, tell me this exact message. A screenshot of the preview always works meanwhile.`
        );
        return;
      }
    } finally {
      setExportBusy(false);
    }
  }

  async function handleExportAll() {
    if (exportBusy) return;
    setExportBusy(true);
    setError("");
    // Each slide used to clear the error before its own attempt, so a failure halfway
    // through was erased by the next slide and only a last-slide failure was ever seen:
    // the button reported success while quietly writing fewer files than it promised.
    const failed: number[] = [];
    try {
      for (let i = 0; i < deck.length; i++) {
        const failure = await exportOne(i);
        if (failure) failed.push(i + 1);
        await new Promise((r) => setTimeout(r, 900));
      }
      if (failed.length) {
        setError(
          `${failed.length} of ${deck.length} slides didn't export (${failed.join(", ")}). ` +
            `The rest downloaded. Try those again individually, or screenshot the preview.`
        );
      }
    } finally {
      setExportBusy(false);
    }
  }
  async function handleExportPdf() {
    if (pdfBusy) return;
    setError("");
    try {
      await exportPdf(elIds, baseW, baseH, (n) => setPdfBusy(n), `kognoz-${format.toLowerCase().replace(/\s+/g, "-")}-deck`);
    } catch (e) {
      setError(`Deck PDF failed (${e instanceof Error ? e.name + ": " + e.message : e}). Per-slide downloads still work; tell me this message if it repeats.`);
    } finally {
      setPdfBusy(0);
    }
  }
  /**
   * The LinkedIn document PDF, for whichever shape this format is.
   *
   * Decks are one element per page. Montage is the opposite: ONE element sliced into
   * `frames` pages, which exportPdf cannot express — hence the separate path.
   */
  async function handleExportDocPdf() {
    if (pdfBusy || exportBusy) return;
    setError("");
    const base = `kognoz-${format.toLowerCase().replace(/\s+/g, "-")}`;
    try {
      if (fmt.frames) {
        await exportFramesPdf("exp-0", baseW, baseH, fmt.frames, `${base}-linkedin`, (k) => setPdfBusy(k));
      } else {
        await exportPdf(elIds, baseW, baseH, (k) => setPdfBusy(k), `${base}-deck`);
      }
    } catch (e) {
      setError(`LinkedIn PDF failed (${e instanceof Error ? e.name + ": " + e.message : e}). The PNGs still work; tell me this message if it repeats.`);
    } finally {
      setPdfBusy(0);
    }
  }

  /**
   * The same content as PNGs, for a native image carousel.
   *
   * Paired with the PDF button rather than folded into it: which one you want depends
   * on how you are posting, and doing both every time writes files you did not ask for.
   */
  async function handleExportPngSet() {
    if (exportBusy || pdfBusy) return;
    if (fmt.frames) {
      // One element, N frame slices.
      await handleExportPNG(0);
      return;
    }
    await handleExportAll();
  }

  async function handleExportPanorama() {
    if (exportBusy) return;
    setExportBusy(true);
    setError("");
    try {
      // "exp-0" is right only because the button is gated on fmt.frames and Montage is
      // the sole format that sets it, so its deck is a single node. Assert that rather
      // than leaving a silent cover-only export for whatever gains `frames` next.
      await exportPanorama("exp-0", baseW, baseH);
    } catch (e) {
      setError(`Panorama failed (${e instanceof Error ? e.name + ": " + e.message : e}).`);
    } finally {
      setExportBusy(false);
    }
  }
  async function handleExportStrip() {
    if (exportBusy) return;
    setExportBusy(true);
    setError("");
    try {
      await exportStrip(elIds, baseW, baseH, `kognoz-${format.toLowerCase().replace(/\s+/g, "-")}-strip`);
    } catch (e) {
      setError(`Whole-deck export failed (${e instanceof Error ? e.name + ": " + e.message : e}). Per-slide downloads still work.`);
    } finally {
      setExportBusy(false);
    }
  }

  // -------------------- Calendar Create-> wiring --------------------
  // PRD §11 originally read "Create -> loads Studio with the item's format+style+set,
  // auto-generates." Generating straight off a URL turned out to be the single largest
  // source of unintended spend in the app: three calendar affordances build these links
  // (one opens in a new tab), and every click, browser reload, or tab-restore bought a
  // full Sonnet generation nobody asked for. Next 14's App Router also enables Strict
  // Mode by default, so in dev each one fired TWICE.
  //
  // So: landing on the link now PRIMES the studio (format, style, set, pillar, topic all
  // filled in) and waits for a click. Auto-run survives only behind an explicit
  // `autorun=1`, latched to fire at most once per mount and stripped from the URL so a
  // reload cannot re-trigger it.
  const autoRanRef = useRef(false);
  // Items created through the editor have ids like "item_lz3k9_ab12". Storing this as
  // a number meant Number(id) -> NaN -> null, so markDrafted never ran and generating
  // from a calendar link never moved the item to Draft.
  const [primedItem, setPrimedItem] = useState<number | string | null>(null);
  const [primedFromCalendar, setPrimedFromCalendar] = useState(false);

  useEffect(() => {
    const qTopic = searchParams.get("topic");
    const qFormat = searchParams.get("format") as FormatId | null;
    const qPillar = searchParams.get("pillar");
    const qSet = searchParams.get("set") as DesignSetId | null;
    const qStyle = searchParams.get("style") as IdeaStyle | null;
    const qN = searchParams.get("n");
    const qChannel = searchParams.get("channel");
    const qAutorun = searchParams.get("autorun") === "1";
    // A calendar slot that has never been filled in links here with an empty topic
    // (`topic=&n=new`). Previously that bailed out entirely and you landed on a blank
    // Studio, losing the format and pillar you had picked. Carry over whatever the
    // link does have; only the topic is required to actually generate.
    if (!qTopic && !qFormat) return;
    if (autoRanRef.current) return;
    autoRanRef.current = true;

    if (qFormat) setFormat(qFormat);
    if (qStyle) setIdeaStyle(qStyle);
    // Was `saveDesign({ ...design, set: qSet })`, which raced the loader below it: if
    // priming won, DEFAULT_DESIGN + qSet was written to the server and the team's saved
    // url/accent/petals were destroyed. Merge onto the latest design at write time.
    if (qSet) setDesignAndPersist((d) => ({ ...d, set: qSet }));
    const resolvedPillar = qPillar && PILLARS[qPillar] ? qPillar : pillar;
    if (qPillar && PILLARS[qPillar]) {
      setPillar(qPillar);
      setEyebrow(qPillar);
    }
    if (qTopic) setTopic(qTopic);
    // Only the three real identities get selected. Anything else — "LinkedIn" is
    // the calendar's quick-add default — leaves the company page selected rather
    // than putting a deck into a real person's first-person voice by accident.
    if (qChannel && (CHANNEL_IDS as string[]).includes(qChannel)) setChannel(qChannel as ChannelId);
    setPrimedFromCalendar(Boolean(qTopic));
    setCurrent(0);
    // `n=new` is an unsaved slot, not a calendar row to mark as drafted. Everything
    // else is passed through as-is: markDrafted matches on both the legacy numeric `n`
    // and the string `id`, so parsing was only ever throwing information away.
    const resolvedN: number | string | null = qN && qN !== "new" ? qN : null;
    setPrimedItem(resolvedN);
    if (!groundedTouched.current && qFormat) setGrounded(groundingDefault(qFormat, resolvedPillar));

    // Both a topic and a format are needed to generate anything. Without them we
    // prime whatever the link carried and wait for the user to press Generate.
    if (qAutorun && qTopic && qFormat) {
      // Consume the flag before generating so a reload lands primed, not billed.
      const url = new URL(window.location.href);
      url.searchParams.delete("autorun");
      window.history.replaceState({}, "", url.toString());
      generate(
        qTopic,
        resolvedPillar,
        qFormat,
        resolvedN,
        false,
        groundingDefault(qFormat, resolvedPillar)
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- latched; runs once on the query params present at mount
  }, [searchParams]);

  // Arrived from a calendar row: that row already holds the caption this asset ships
  // with, which is the text whose truncation actually matters.
  useEffect(() => {
    if (primedItem == null || captionTouched.current) return;
    let live = true;
    (async () => {
      const { value: plan } = await storeGet<{ items: { id?: string; n?: number; content?: string }[] }>("kognoz-calendar");
      if (!live || !plan || !Array.isArray(plan.items)) return;
      const hit = plan.items.find(
        (it) => it.id === String(primedItem) || (typeof it.n === "number" && it.n === Number(primedItem))
      );
      if (hit?.content && !captionTouched.current) setPreviewCaption(hit.content);
    })();
    return () => {
      live = false;
    };
  }, [primedItem]);


  // -------------------- style helpers (ported verbatim) --------------------
  const label: React.CSSProperties = { fontFamily: font, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.inkMute, marginBottom: 8, display: "block" };
  const inputStyle: React.CSSProperties = { fontFamily: font, width: "100%", padding: "10px 12px", border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 13.5, color: C.ink, background: C.white, boxSizing: "border-box", outline: "none", resize: "vertical", lineHeight: 1.5 };
  const chip = (on: boolean, col: string): React.CSSProperties => ({ fontFamily: font, fontSize: 12.5, fontWeight: 600, padding: "8px 13px", borderRadius: 20, cursor: "pointer", border: `1.5px solid ${on ? col : C.line}`, background: on ? col : C.white, color: on ? "#fff" : C.inkSoft, transition: "all .15s", display: "inline-flex", alignItems: "center", gap: 7 });
  const btn = (primary: boolean): React.CSSProperties => ({ fontFamily: font, fontSize: 13.5, fontWeight: 700, padding: "11px 18px", borderRadius: 8, cursor: loading ? "default" : "pointer", border: "none", color: "#fff", background: primary ? GRAD : C.blue, opacity: loading ? 0.6 : 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%" });

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.off, fontFamily: font, color: C.ink, overflowX: "hidden" }}>
      {/* ---------------- CONTROLS SIDEBAR (Fully Collapsible) ---------------- */}
      <div
        style={{
          width: sidebarCollapsed ? 0 : isMobile ? "100vw" : 400,
          minWidth: sidebarCollapsed ? 0 : isMobile ? "100vw" : 400,
          maxWidth: sidebarCollapsed ? 0 : isMobile ? "100vw" : 400,
          flexShrink: 0,
          background: C.white,
          borderRight: sidebarCollapsed ? "none" : `1px solid ${C.line}`,
          overflowY: sidebarCollapsed ? "hidden" : "auto",
          overflowX: "hidden",
          padding: sidebarCollapsed ? 0 : isMobile ? "20px 18px" : "26px 24px",
          opacity: sidebarCollapsed ? 0 : 1,
          pointerEvents: sidebarCollapsed ? "none" : "auto",
          transition: "width 0.3s cubic-bezier(0.4, 0, 0.2, 1), min-width 0.3s cubic-bezier(0.4, 0, 0.2, 1), max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1), padding 0.3s ease, opacity 0.2s ease",
          display: "flex",
          flexDirection: "column",
          position: isMobile ? "fixed" : "relative",
          top: 0,
          left: 0,
          height: isMobile ? "100vh" : "auto",
          zIndex: 50,
          boxSizing: "border-box"
        }}
      >
        <div style={{ width: "100%", maxWidth: 352, display: "flex", flexDirection: "column", margin: isMobile ? "0 auto" : 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <Logo h={32} />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {session?.user && (
                <span
                  title={session.user.email || ""}
                  style={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: C.blue,
                    background: C.mist,
                    padding: "4px 9px",
                    borderRadius: 12,
                    maxWidth: 120,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }}
                >
                  {session.user.name || session.user.email?.split("@")[0]}
                </span>
              )}
              {/* Complete Minimize / Close Button */}
              <button
                type="button"
                onClick={toggleSidebar}
                title="Minimize sidebar"
                style={{
                  height: 28,
                  padding: "0 10px",
                  borderRadius: 6,
                  border: `1px solid ${C.line}`,
                  background: C.mist,
                  color: C.blue,
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  transition: "all 0.15s ease"
                }}
              >
                <span>◀</span>
                <span>{isMobile ? "Close" : "Minimize"}</span>
              </button>
              {session?.user && (
                <button
                  type="button"
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  style={{
                    border: `1px solid ${C.line}`,
                    background: "transparent",
                    color: C.inkMute,
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 6,
                    padding: "3px 7px",
                    cursor: "pointer"
                  }}
                >
                  Exit
                </button>
              )}
            </div>
          </div>
        <div style={{ fontFamily: font, fontSize: 13, color: C.inkMute, lineHeight: 1.5, marginBottom: 14 }}>Type a topic. Kognoz-voiced content and on-brand design, generated together.</div>
        <a href="/calendar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", borderRadius: 10, background: C.mist, cursor: "pointer", marginBottom: 22, border: `1px solid ${C.line}`, textDecoration: "none" }}>
          <div style={{ fontFamily: font, fontSize: 13, fontWeight: 700, color: C.blue }}>Content Calendar</div>
          <div style={{ fontFamily: font, fontSize: 12, color: C.inkMute }}>→</div>
        </a>

        {/* Step one, and deliberately the heaviest control on the panel. Generation is
            format-specific — the prompt, the slide count and what a "slide" even means
            all differ — so choosing afterwards means paying for a second run. */}
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 16px 16px", marginBottom: 20, background: C.off }}>
          <span style={{ ...label, marginBottom: 10 }}>Step 1 · Choose the format first</span>
          <div role="radiogroup" aria-label="Content format" style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {(Object.keys(FORMATS) as FormatId[]).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                onClick={() => selectFormat(f)}
                disabled={busy}
                // `font` is the shorthand for the fontFamily/fontSize/fontWeight that
                // chip() sets, so it reset them and React warned about the conflict on
                // every re-render. The second spread was a verbatim duplicate.
                style={{ ...chip(format === f, C.blue), cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1 }}
              >
                {FORMATS[f].hint}
              </button>
            ))}
          </div>
          <div style={{ fontFamily: font, fontSize: 11.5, color: C.inkSoft, marginTop: 11, lineHeight: 1.5 }}>
            <b style={{ color: C.ink }}>{format}</b> · {FORMAT_BRIEF[format]}.{" "}
            <span style={{ color: C.inkMute }}>
              Claude writes for this format specifically, so switching afterwards means generating again.
            </span>
          </div>
        </div>

        {format === "Idea Deck" && (
          <div style={{ marginBottom: 20 }}>
            <span style={label}>Deck style</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {([["signals", "Signals"], ["book", "Book review"], ["story", "Story"]] as [IdeaStyle, string][]).map(([k, lb]) => (
                <div
                  key={k}
                  onClick={() => { if (!busy) setIdeaStyle(k); }}
                  style={{ ...chip(ideaStyle === k, C.teal), cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1 }}
                >
                  {lb}
                </div>
              ))}
            </div>
          </div>
        )}

        <span style={label}>Content pillar</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 22 }}>
          {Object.keys(PILLARS).map((p) => (
            <div
              key={p}
              onClick={() => {
                if (busy) return; // setEyebrow(gPillar) at the end of generate() would revert it anyway
                setPillar(p);
                setEyebrow(p);
              }}
              style={{ ...chip(pillar === p, PILLARS[p]), cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1 }}
            >
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: pillar === p ? "#fff" : PILLARS[p] }} />
              {p}
            </div>
          ))}
        </div>

        {/*
          Whose voice this deck is in. Decks had no such notion, so unlike a
          caption they could not pick the right person's writing samples, and the
          copy came out belonging to nobody.
        */}
        <span style={label}>Publishing as</span>
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {CHANNEL_IDS.map((c) => (
            <div
              key={c}
              onClick={() => { if (!busy) setChannel(c); }}
              style={{ ...chip(channel === c, C.blue), cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1 }}
            >
              {c}
            </div>
          ))}
        </div>

        <span style={label}>Topic</span>
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={2}
          placeholder={
            format === "Idea Deck" && ideaStyle === "book"
              ? "Book title, Author (e.g. The Culture Code, Daniel Coyle)"
              : format === "Idea Deck" && ideaStyle === "story"
              ? "The situation (e.g. inside a founder-family succession conversation)"
              : "e.g. Why internal mobility beats external hiring for scarce AI skills"
          }
          style={{ ...inputStyle, marginBottom: 10 }}
        />

        {/*
          Raw material. This is the difference between writing ABOUT a subject
          and writing FROM something, and it is the deepest fix available for
          copy that reads generic: a topic line gives the model nothing specific
          to say, so it says the general thing.
        */}
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
            fontFamily: font, fontSize: 11.5, fontWeight: 700, color: sourceMaterial.trim() ? C.teal : C.inkSoft,
            background: "none", border: "none", padding: "0 0 8px", cursor: "pointer"
          }}
        >
          <span>{showSource ? "▾" : "▸"}</span>
          <span>
            Notes, transcript or rough thoughts
            {sourceMaterial.trim() ? ` · ${sourceMaterial.trim().length.toLocaleString()} characters` : " · optional"}
          </span>
        </button>
        {showSource && (
          <>
            <textarea
              value={sourceMaterial}
              onChange={(e) => saveSourceMaterial(e.target.value.slice(0, MAX_SOURCE_CHARS))}
              rows={5}
              placeholder="Paste what you actually have. A call transcript, notes from a client conversation, a paragraph you dictated on the way home. Specifics beat polish here: names of behaviours, numbers somebody quoted, what was actually said in the room."
              style={{ ...inputStyle, marginBottom: 6, fontSize: 12.5 }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: font, fontSize: 10.5, color: C.inkMute, marginBottom: 10, lineHeight: 1.5 }}>
              <span>
                {sourceMaterial.length >= MAX_SOURCE_CHARS
                  ? `At the ${MAX_SOURCE_CHARS.toLocaleString()} character limit. Trim to the part that matters.`
                  : `${(MAX_SOURCE_CHARS - sourceMaterial.length).toLocaleString()} characters left. Used for the draft only, never the edit pass.`}
              </span>
              {sourceMaterial.trim() && (
                <button type="button" onClick={() => saveSourceMaterial("")} style={{ fontFamily: font, fontSize: 10.5, color: C.inkMute, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  clear
                </button>
              )}
            </div>
          </>
        )}
        <label
          style={{
            display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 10, cursor: "pointer",
            border: `1px solid ${grounded ? C.line : "transparent"}`, borderRadius: 8,
            padding: grounded ? "9px 10px" : "0 0 2px", background: grounded ? C.off : "transparent"
          }}
        >
          <input
            type="checkbox"
            checked={grounded}
            onChange={(e) => { groundedTouched.current = true; setGrounded(e.target.checked); }}
            style={{ marginTop: 2, accentColor: C.ink, cursor: "pointer" }}
          />
          <span style={{ fontFamily: font, fontSize: 12, color: C.inkSoft, lineHeight: 1.45 }}>
            Ground with web search
            <span style={{ color: C.inkMute }}>
              {" "}· verifies statistics live, up to 2 searches. Costs several times a plain
              generation, so leave it off unless the piece leans on external numbers.
            </span>
          </span>
        </label>
        <button
          onClick={() => generate(undefined, undefined, undefined, primedItem)}
          // generate() also bails without a topic and while a revision runs, so the
          // app's primary button used to look live and do nothing on a fresh load.
          disabled={busy || !topic.trim()}
          style={{ ...btn(true), opacity: busy || !topic.trim() ? 0.55 : 1, cursor: busy || !topic.trim() ? "default" : "pointer" }}
          title={!topic.trim() ? "Type a topic first" : undefined}
        >
          {loading
            ? "Writing & designing…"
            : `Generate ${format}${grounded ? " · grounded" : ""}`}
        </button>
        {staleFormat && !loading && (
          <div style={{ fontFamily: font, fontSize: 11.5, color: "#B4442E", marginTop: 8, lineHeight: 1.5 }}>
            This text was written for a different format. Generate again so Claude writes it for {format} · {FORMAT_BRIEF[format]}.
          </div>
        )}
        {primedFromCalendar && !loading && (
          <div style={{ fontFamily: font, fontSize: 11.5, color: C.inkMute, marginTop: 8, lineHeight: 1.5 }}>
            Loaded from the calendar and ready. Nothing has been generated yet — press Generate when the brief looks right.
          </div>
        )}
        {error && <div style={{ fontFamily: font, fontSize: 12, color: "#B4442E", marginTop: 10, lineHeight: 1.5 }}>{error}</div>}

        {/*
          What the automated style check makes of what is on screen. It is a nudge,
          not a verdict: the lexical findings (a banned word, an em dash) are
          objective, the rhythm ones are hints. Shown because the ban list used to
          be prompt text that nothing ever verified, so a violation shipped silently.
        */}
        {styleReport && (
          <div style={{ marginTop: 10, fontFamily: font, fontSize: 11.5, lineHeight: 1.55 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, color: styleReport.score >= 85 ? C.teal : styleReport.score >= 60 ? "#B8860B" : "#B4442E" }}>
                Style check {styleReport.score}/100
              </span>
              {passNote && <span style={{ color: C.inkMute }}>{passNote}</span>}
            </div>
            {styleReport.findings.length > 0 && (
              <ul style={{ margin: "5px 0 0", paddingLeft: 16, color: C.inkSoft }}>
                {styleReport.findings.slice(0, 5).map((f, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>
                    {f.where ? `${f.where}: ` : ""}
                    {f.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/*
          What the line-editing pass actually changed.
          Without this the second pass is a black box: it rewrites the deck and
          the only feedback is a score. Here a person can read both wordings and
          keep their own on any single field.
        */}
        {editDiff && editDiff.length > 0 && (
          <div style={{ marginTop: 12, border: `1px solid ${C.line}`, borderRadius: 9, background: C.mist, padding: "10px 11px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 7 }}>
              <span style={{ fontFamily: font, fontSize: 11.5, fontWeight: 700, color: C.ink }}>
                The edit pass changed {editDiff.length} {editDiff.length === 1 ? "field" : "fields"}
              </span>
              <button
                type="button"
                onClick={revertEditPass}
                disabled={editDiff.every((r) => r.using === "original")}
                style={{
                  fontFamily: font, fontSize: 10.5, fontWeight: 600, background: "none", border: "none", padding: 0,
                  color: editDiff.every((r) => r.using === "original") ? C.inkMute : C.blue,
                  cursor: editDiff.every((r) => r.using === "original") ? "default" : "pointer"
                }}
              >
                keep all originals
              </button>
            </div>

            <div style={{ maxHeight: 260, overflowY: "auto" }}>
              {editDiff.map((row) => (
                <div key={row.key} style={{ padding: "7px 0", borderTop: `1px solid ${C.line}` }}>
                  <div style={{ fontFamily: font, fontSize: 10, fontWeight: 700, color: C.teal, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>
                    {row.where}
                  </div>
                  {(["original", "edited"] as const).map((which) => (
                    <button
                      key={which}
                      type="button"
                      onClick={() => useWording(row.key, which)}
                      style={{
                        display: "block", width: "100%", textAlign: "left", marginBottom: 3, padding: "5px 7px",
                        fontFamily: font, fontSize: 11.5, lineHeight: 1.45, borderRadius: 6, cursor: "pointer",
                        whiteSpace: "pre-wrap",
                        border: `1px solid ${row.using === which ? C.blue : C.line}`,
                        background: row.using === which ? C.white : "transparent",
                        color: row.using === which ? C.ink : C.inkSoft,
                        fontWeight: row.using === which ? 600 : 400
                      }}
                    >
                      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, color: C.inkMute, textTransform: "uppercase" }}>
                        {which === "original" ? "first draft" : "edited"}
                      </span>
                      <br />
                      {(which === "original" ? row.original : row.edited) || "(empty)"}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {format === "Article Cover" && (
          <div style={{ marginTop: 14, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, background: C.off }}>
            <span style={label}>The article itself · the cover is the billboard, this is the asset</span>
            {articleUndo && (
              <div style={{ fontFamily: font, fontSize: 11.5, color: C.inkMute, marginBottom: 8, lineHeight: 1.5 }}>
                Claude replaced your article.{" "}
                <button
                  type="button"
                  onClick={() => { setArticle(articleUndo.text); setArticleUndo(null); }}
                  style={{ fontFamily: font, fontSize: 11.5, fontWeight: 700, color: C.blue, background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
                >
                  Undo the {articleUndo.label}
                </button>
              </div>
            )}
            {(staleArticle || draftTopicMismatch) && (
              <div style={{ fontFamily: font, fontSize: 11.5, color: C.inkMute, marginBottom: 8, lineHeight: 1.5 }}>
                Written for the previous version of this deck. Still yours to edit — rewrite only if it no longer fits.
              </div>
            )}
            <button
              onClick={() => writeArticle()}
              disabled={artBusy || loading || !topic.trim()}
              // It sat greyed out with no explanation, which reads as broken rather than
              // as waiting for input. Same wording as the main Generate button.
              title={!topic.trim() ? "Type a topic first" : undefined}
              style={{ ...btn(true), opacity: artBusy || loading || !topic.trim() ? 0.6 : 1, marginBottom: 10 }}
            >
              {artBusy ? "Writing the article…" : article ? "Rewrite from scratch" : "Write the full article"}
            </button>
            {article && (
              <>
                <textarea
                  value={article}
                  onChange={(e) => setArticle(e.target.value)}
                  // Saved on blur rather than on every keystroke — the same pattern House
                  // style already uses for its textarea.
                  onBlur={(e) => saveArticleDraft(e.target.value)}
                  rows={16}
                  style={{ ...inputStyle, fontFamily: font, fontSize: 12.5, lineHeight: 1.6, marginBottom: 8 }}
                />
                <div style={{ fontFamily: font, fontSize: 11, color: C.inkMute, marginBottom: 8 }}>{article.split(/\s+/).filter(Boolean).length} words · markdown headings paste cleanly into LinkedIn's article editor</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <input value={artInstr} onChange={(e) => setArtInstr(e.target.value)} placeholder="Revise: e.g. sharpen the hook, shorten section 3, add a Gulf example" style={{ ...inputStyle, flex: 1, marginBottom: 0 }} />
                  <button
                    onClick={() => writeArticle(artInstr)}
                    disabled={artBusy || loading || !artInstr.trim()}
                    // A bare glyph with no accessible name and no tooltip.
                    title="Revise the article with this instruction"
                    aria-label="Revise the article with this instruction"
                    style={{ fontFamily: font, fontSize: 12, fontWeight: 700, padding: "0 14px", borderRadius: 8, cursor: artBusy || loading || !artInstr.trim() ? "default" : "pointer", border: "none", color: "#fff", background: GRAD, opacity: artBusy || loading || !artInstr.trim() ? 0.55 : 1 }}
                  >
                    ↻
                  </button>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={async () => {
                      // writeText returns a promise, so a denied permission or an
                      // insecure origin escaped the old synchronous catch as an
                      // unhandled rejection and the button gave no feedback either way.
                      try {
                        await navigator.clipboard.writeText(article);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1600);
                      } catch {
                        setError("Couldn't copy — your browser blocked clipboard access. Select the text and copy it manually.");
                      }
                    }}
                    style={{ fontFamily: font, fontSize: 12, fontWeight: 700, padding: "8px 14px", borderRadius: 8, cursor: "pointer", border: `1.5px solid ${C.blue}`, color: C.blue, background: "transparent" }}
                  >
                    {copied ? "Copied ✓" : "Copy article"}
                  </button>
                  <button
                    onClick={() => saveBlobAs(new Blob([article], { type: "text/markdown" }), "kognoz-article.md")}
                    style={{ fontFamily: font, fontSize: 12, fontWeight: 700, padding: "8px 14px", borderRadius: 8, cursor: "pointer", border: `1.5px solid ${C.blue}`, color: C.blue, background: "transparent" }}
                  >
                    ⬇ .md file
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div style={{ marginTop: 14, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, background: C.off }}>
          <span style={label}>Facts · checked against the live web before you publish</span>
          <button onClick={verifyFacts} disabled={verifying || busy} style={{ ...btn(true), opacity: verifying || busy ? 0.6 : 1, marginBottom: verifyRes ? 10 : 0 }}>
            {verifying ? "Searching & checking…" : "Verify facts"}
          </button>
          {staleVerify && verifyRes && (
            <div style={{ fontFamily: font, fontSize: 11.5, color: C.inkMute, marginBottom: 8, lineHeight: 1.5 }}>
              Checked against the previous version of this deck. Re-verify only if the claims changed.
            </div>
          )}
          {verifyRes && (
            <>
              {verifyRes.map((c, i) => (
                <div key={i} style={{ fontFamily: font, fontSize: 12, lineHeight: 1.5, marginBottom: 8, padding: "8px 10px", borderRadius: 8, background: C.white, borderLeft: `4px solid ${c.verdict === "verified" ? C.green : c.verdict === "wrong" ? "#B4442E" : "#C79A2A"}` }}>
                  <b>
                    {c.verdict === "verified" ? "✓" : c.verdict === "wrong" ? "✗" : "?"} {c.where}
                  </b>{" "}
                  · {c.claim}
                  <div style={{ color: C.inkMute, marginTop: 3 }}>
                    {c.note}
                    {c.realSource ? ` — real source: ${c.realSource}` : ""}
                  </div>
                </div>
              ))}
              {verifyRes.some((c) => c.verdict !== "verified") && verifyFixed ? (
                <button
                  onClick={applyVerified}
                  disabled={loading || modLoading || verifying}
                  style={{
                    fontFamily: font, fontSize: 12.5, fontWeight: 700, padding: "9px 16px", borderRadius: 8,
                    cursor: loading || modLoading || verifying ? "default" : "pointer",
                    opacity: loading || modLoading || verifying ? 0.6 : 1,
                    border: "none", color: "#fff", background: GRAD
                  }}
                >
                  Apply corrections
                </button>
              ) : verifyRes.some((c) => c.verdict !== "verified") ? (
                <div style={{ fontFamily: font, fontSize: 12, color: C.inkMute, lineHeight: 1.5 }}>
                  The deck changed after this check, so these fixes no longer match what is on screen.
                  Run “Verify facts” again to correct the current version.
                </div>
              ) : (
                <div style={{ fontFamily: font, fontSize: 12, color: C.green, fontWeight: 700 }}>All claims verified. Publish with confidence.</div>
              )}
            </>
          )}
        </div>

        <div style={{ marginTop: 14 }}>
          <span style={label}>Iterate on content · design elements have their own panel below</span>
          {deckUndo && (
            <div style={{ fontFamily: font, fontSize: 11.5, color: C.inkMute, marginBottom: 8, lineHeight: 1.5 }}>
              Claude replaced your text.{" "}
              <button
                type="button"
                onClick={restoreDeck}
                style={{ fontFamily: font, fontSize: 11.5, fontWeight: 700, color: C.blue, background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
              >
                Undo the {deckUndo.label}
              </button>{" "}
              (Cmd/Ctrl+Z)
            </div>
          )}
          <textarea value={modTxt} onChange={(e) => setModTxt(e.target.value)} rows={2} placeholder="Tell Claude what to change: sharper hook, add a real number, aim it at CEOs, warmer close, shorter slides…" style={{ ...inputStyle, marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={modifyContent} disabled={busy || !modTxt.trim()} style={{ ...btn(false), flex: 1, opacity: busy || !modTxt.trim() ? 0.55 : 1, cursor: busy || !modTxt.trim() ? "default" : "pointer" }}>
              {modLoading ? "Revising…" : "↻ Revise content"}
            </button>
            <button
              onClick={() => appendPref(modTxt)}
              disabled={!modTxt.trim()}
              title="Add this instruction to House style so every future draft follows it"
              style={{ fontFamily: font, fontSize: 12, fontWeight: 700, padding: "0 12px", borderRadius: 8, cursor: modTxt.trim() ? "pointer" : "default", border: `1.5px solid ${C.teal}`, color: C.teal, background: "transparent", opacity: modTxt.trim() ? 1 : 0.5 }}
            >
              + Rule
            </button>
          </div>
          <button onClick={startFresh} disabled={busy || !topic.trim()} style={{ ...btn(false), background: "transparent", color: C.blue, border: `1.5px solid ${C.blue}`, marginTop: 8, opacity: busy || !topic.trim() ? 0.55 : 1, cursor: busy || !topic.trim() ? "default" : "pointer" }}>
            {loading ? "Regenerating…" : "⟳ Regenerate afresh"}
          </button>
          <div style={{ fontFamily: font, fontSize: 11, color: C.inkMute, marginTop: 7, lineHeight: 1.5 }}>
            Revise refines the current draft. Regenerate afresh discards it: a mandated new angle, a new layout deal, and earlier shape references ignored for that run. For design alone, "Next look" under the preview re-deals layouts without touching the words.
          </div>
        </div>

        <div style={{ marginTop: 18, padding: "14px 14px 12px", background: C.off, borderRadius: 10, border: `1px solid ${C.line}` }}>
          <span style={label}>Design set · one family per deck</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {(Object.keys(DESIGN_SETS) as DesignSetId[]).map((k) => (
              <div key={k} onClick={() => saveDesign({ ...design, set: k })} style={chip((design.set || "editorial") === k, C.blue)}>
                {DESIGN_SETS[k].label}
              </div>
            ))}
          </div>
          <span style={label}>Accent tone</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12, alignItems: "center" }}>
            <div onClick={() => saveDesign({ ...design, accent: null })} style={chip(!design.accent, C.blue)}>
              Auto (pillar)
            </div>
            {([["Blue", C.blue], ["Teal", C.teal], ["Cyan", C.cyan], ["Green", C.green]] as [string, string][]).map(([nm, cv]) => (
              <div key={nm} onClick={() => saveDesign({ ...design, accent: cv })} style={{ ...chip(design.accent === cv, cv), display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: cv }} />
                {nm}
              </div>
            ))}
          </div>
          <span style={label}>Design elements</span>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input value={designNote} onChange={(e) => setDesignNote(e.target.value)} placeholder="e.g. show the website on every slide · hide page numbers · no circles" style={{ ...inputStyle, fontSize: 12.5, marginBottom: 0 }} />
            <button onClick={applyDesignNote} disabled={designBusy || loading || !designNote.trim()} style={{ fontFamily: font, fontSize: 12, fontWeight: 700, padding: "0 14px", borderRadius: 8, cursor: designBusy || loading || !designNote.trim() ? "default" : "pointer", border: "none", color: "#fff", background: C.teal, opacity: designBusy || loading || !designNote.trim() ? 0.55 : 1, whiteSpace: "nowrap" }}>
              {designBusy ? "…" : "Apply"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div>
              <span style={{ ...label, fontSize: 10 }}>Cover corner</span>
              <select value={design.coverRight} onChange={(e) => saveDesign({ ...design, coverRight: e.target.value as "swipe" | "url" | "none" })} style={{ ...inputStyle, fontSize: 12.5, padding: "8px 10px", marginBottom: 0 }}>
                <option value="swipe">Swipe</option>
                <option value="url">Website</option>
                <option value="none">None</option>
              </select>
            </div>
            <div>
              <span style={{ ...label, fontSize: 10 }}>Slide corner</span>
              <select value={design.contentRight} onChange={(e) => saveDesign({ ...design, contentRight: e.target.value as "page" | "url" | "none" })} style={{ ...inputStyle, fontSize: 12.5, padding: "8px 10px", marginBottom: 0 }}>
                <option value="page">Page numbers</option>
                <option value="url">Website</option>
                <option value="none">None</option>
              </select>
            </div>
            <div>
              <span style={{ ...label, fontSize: 10 }}>Card corner</span>
              <select value={design.singleRight} onChange={(e) => saveDesign({ ...design, singleRight: e.target.value as "cta" | "url" | "none" })} style={{ ...inputStyle, fontSize: 12.5, padding: "8px 10px", marginBottom: 0 }}>
                <option value="cta">Closing line</option>
                <option value="url">Website</option>
                <option value="none">None</option>
              </select>
            </div>
            <div>
              <span style={{ ...label, fontSize: 10 }}>Website line</span>
              <input value={design.url} onChange={(e) => setDesignLocal({ ...design, url: e.target.value })} onBlur={(e) => saveDesign({ ...design, url: e.target.value })} style={{ ...inputStyle, fontSize: 12.5, padding: "8px 10px", marginBottom: 0 }} />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font, fontSize: 12.5, color: C.inkSoft, cursor: "pointer" }}>
            <input type="checkbox" checked={design.petals} onChange={(e) => saveDesign({ ...design, petals: e.target.checked })} />
            Background circle motif
          </label>
          <div style={{ fontFamily: font, fontSize: 10.5, color: C.inkMute, marginTop: 7, lineHeight: 1.5 }}>The website address lives here as a design element and never appears inside the written content. Content instructions go in &quot;Iterate on content&quot; above.</div>
        </div>

        <div style={{ marginTop: 14, padding: "14px 14px 12px", background: C.mist, borderRadius: 10, border: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ ...label, marginBottom: 0 }}>House style · applied to every generation</span>
            <button type="button" onClick={saveStyleExample} title="Save this deck's shape — slide count and how much text sits in each field — as a reference for future drafts. Its wording is not copied." style={{ fontFamily: font, fontSize: 10.5, fontWeight: 700, color: C.teal, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              {styleMem.length} shape reference{styleMem.length === 1 ? "" : "s"} · save this one
            </button>
          </div>
          <textarea value={housePrefs} onChange={(e) => setHousePrefsLocal(e.target.value)} onBlur={(e) => saveHousePrefs(e.target.value)} rows={3} placeholder='Standing notes Claude follows on every draft. Your revision instructions land here automatically; edit or prune anytime.' style={{ ...inputStyle, background: C.white, fontSize: 12.5 }} />
          <div style={{ fontFamily: font, fontSize: 10.5, color: C.inkMute, marginTop: 6, lineHeight: 1.5 }}>Only rules you save with &quot;+ Rule&quot; land here, so one-off instructions never pollute future drafts. Shape references are saved by hand now: downloading a deck no longer files it as an example to imitate.</div>
        </div>

        {/*
          The voice corpus. This is the lever that decides whether the output reads
          as a person, so it sits beside House style rather than behind a settings
          page. What goes in here is real published writing; what comes out of the
          generator is not, which is why the two stores are kept apart.
        */}
        <div style={{ marginTop: 14, padding: "14px 14px 12px", background: C.mist, borderRadius: 10, border: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ ...label, marginBottom: 0 }}>Voice samples · real writing to imitate</span>
            <button type="button" onClick={() => setShowSamples((v) => !v)} style={{ fontFamily: font, fontSize: 10.5, fontWeight: 700, color: voiceSamples.length ? C.teal : "#C4553D", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              {voiceSamples.length} saved · {showSamples ? "hide" : "manage"}
            </button>
          </div>

          {!voiceSamples.length && (
            <div style={{ fontFamily: font, fontSize: 11.5, color: "#C4553D", lineHeight: 1.5, marginBottom: 8 }}>
              Nothing here yet. Until real posts are pasted in, drafts have no human writing to measure themselves against and will keep reading as machine-written.
            </div>
          )}

          {showSamples && (
            <>
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <select value={sampleChannel} onChange={(e) => setSampleChannel(e.target.value as ChannelId)} style={{ ...inputStyle, fontSize: 12, padding: "7px 8px", marginBottom: 0, flex: 1 }}>
                  {CHANNEL_IDS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select value={sampleKind} onChange={(e) => setSampleKind(e.target.value as SampleKind)} style={{ ...inputStyle, fontSize: 12, padding: "7px 8px", marginBottom: 0, width: 96 }}>
                  {SAMPLE_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>
              <textarea value={sampleDraft} onChange={(e) => setSampleDraft(e.target.value)} rows={4} placeholder="Paste one real published post, whole. Not a summary of it, and not something the tool wrote." style={{ ...inputStyle, background: C.white, fontSize: 12.5, marginBottom: 6 }} />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" onClick={addSample} disabled={!sampleDraft.trim()} style={{ fontFamily: font, fontSize: 11.5, fontWeight: 700, padding: "7px 12px", borderRadius: 7, border: `1px solid ${C.line}`, background: sampleDraft.trim() ? C.white : C.mist, color: C.ink, cursor: sampleDraft.trim() ? "pointer" : "default" }}>
                  Add sample
                </button>
                <button type="button" onClick={importTemplateSamples} title="Import the hand-written copy from the agreed editorial plan already in this repo" style={{ fontFamily: font, fontSize: 11.5, fontWeight: 600, padding: "7px 12px", borderRadius: 7, border: `1px solid ${C.line}`, background: C.white, color: C.inkSoft, cursor: "pointer" }}>
                  Import from the editorial plan
                </button>
              </div>

              <div style={{ marginTop: 10, maxHeight: 220, overflowY: "auto" }}>
                {voiceSamples.map((v) => (
                  <div key={v.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 0", borderTop: `1px solid ${C.line}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: font, fontSize: 10, fontWeight: 700, color: C.teal, textTransform: "uppercase", letterSpacing: 0.4 }}>
                        {v.channel} · {v.kind}
                      </div>
                      <div style={{ fontFamily: font, fontSize: 11.5, color: C.inkSoft, lineHeight: 1.45 }}>
                        {v.text.length > 150 ? v.text.slice(0, 150) + "…" : v.text}
                      </div>
                    </div>
                    <button type="button" onClick={() => removeSample(v.id)} title="Remove this sample" style={{ fontFamily: font, fontSize: 14, lineHeight: 1, color: C.inkMute, background: "none", border: "none", cursor: "pointer", padding: 2 }}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div style={{ fontFamily: font, fontSize: 10.5, color: C.inkMute, marginTop: 6, lineHeight: 1.5 }}>
            Every draft is written once, then line-edited a second time against these samples. Paste posts people actually published; a sample the tool wrote teaches it to sound like itself.
          </div>
        </div>

        <div style={{ height: 1, background: C.line, margin: "24px 0 20px" }} />

        <span style={label}>Cover headline · mark one word *like this* for the gradient</span>
        <textarea value={cover} onChange={(e) => setCover(e.target.value)} rows={2} style={{ ...inputStyle, marginBottom: 18, fontFamily: displayFont, fontSize: 15 }} />

        <span style={label}>Closing / CTA</span>
        <textarea value={cta} onChange={(e) => setCta(e.target.value)} rows={2} style={{ ...inputStyle, fontFamily: displayFont, fontSize: 15 }} />
        </div>
      </div>

      {/* ---------------- PREVIEW CANVAS ---------------- */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", background: "#E6ECF0", padding: sidebarCollapsed ? (isMobile ? "14px 12px 40px" : "24px 24px 40px") : (isMobile ? "18px 12px 40px" : "56px 24px 40px"), position: "relative", overflowY: "auto", overflowX: "hidden", transition: "padding 0.28s ease", width: "100%", boxSizing: "border-box" }}>
        {/* Floating Top Navbar when Sidebar is Minimized */}
        {sidebarCollapsed && (
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: isMobile ? 8 : 14,
              width: "100%",
              maxWidth: previewW,
              background: "rgba(255, 255, 255, 0.95)",
              backdropFilter: "blur(14px)",
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              padding: isMobile ? "8px 10px" : "10px 18px",
              marginBottom: isMobile ? 16 : 24,
              boxShadow: "0 6px 20px rgba(0, 30, 60, 0.08)",
              flexShrink: 0,
              transition: "all 0.28s ease",
              boxSizing: "border-box",
              overflow: "hidden"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 12, minWidth: 0, flexShrink: 1 }}>
              <button
                type="button"
                onClick={toggleSidebar}
                style={{
                  fontFamily: font,
                  fontSize: isMobile ? 11.5 : 12.5,
                  fontWeight: 700,
                  color: "#ffffff",
                  background: C.blue,
                  border: "none",
                  borderRadius: 8,
                  padding: isMobile ? "6px 10px" : "7px 14px",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  boxShadow: "0 2px 8px rgba(0, 81, 132, 0.25)",
                  flexShrink: 0
                }}
              >
                <span>☰</span>
                <span>{isMobile ? "Controls" : "Open Studio Controls"}</span>
              </button>

              <span style={{ fontSize: isMobile ? 11 : 13, fontWeight: 700, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {format} · <span style={{ color: PILLARS[pillar] || C.blue }}>{pillar}</span>
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 10, flexShrink: 0 }}>
              {!isMobile && topic && (
                <span
                  title={topic}
                  style={{
                    fontSize: 12,
                    color: C.inkMute,
                    maxWidth: 220,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }}
                >
                  &quot;{topic}&quot;
                </span>
              )}
              <button
                type="button"
                // Passing primedItem here too: without it a regenerate from this toolbar
                // never marked the calendar item as drafted, unlike the sidebar twin.
                onClick={() => generate(undefined, undefined, undefined, primedItem)}
                disabled={busy || !topic.trim()}
                title={`Regenerate with Claude · writes for ${format}`}
                style={{
                  fontFamily: font,
                  fontSize: isMobile ? 11 : 12,
                  fontWeight: 700,
                  color: "#fff",
                  background: GRAD,
                  border: "none",
                  borderRadius: 8,
                  padding: isMobile ? "6px 10px" : "7px 16px",
                  cursor: loading || !topic.trim() ? "default" : "pointer",
                  opacity: loading || !topic.trim() ? 0.6 : 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4
                }}
              >
                <span>⚡</span>
                <span>{isMobile ? (loading ? "…" : "Regen") : loading ? "Generating…" : "Regenerate"}</span>
              </button>
              <a
                href="/calendar"
                title="Content Calendar"
                style={{
                  fontFamily: font,
                  fontSize: isMobile ? 11 : 12,
                  fontWeight: 700,
                  color: C.blue,
                  background: C.mist,
                  border: `1px solid ${C.line}`,
                  borderRadius: 8,
                  padding: isMobile ? "6px 9px" : "7px 12px",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4
                }}
              >
                <span>📅</span>
                {!isMobile && <span>Calendar</span>}
              </a>
            </div>
          </div>
        )}

        <div style={{ alignSelf: "flex-start", marginBottom: 14, flexShrink: 0, fontFamily: font, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.inkMute }}>
          {cur.kind === "cover" ? "Cover" : cur.kind === "end" ? "Closing" : cur.kind === "content" ? `Slide ${current} of ${total}` : format} · {baseW}×{baseH}
        </div>

        <div style={{ position: "relative", width: previewW, height: baseH * previewScale, flexShrink: 0, borderRadius: 14 * previewScale, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,40,70,0.22)", background: "#fff" }}>
          {fmt.frames &&
            [...Array(fmt.frames - 1)].map((_, k) => (
              <div key={k} style={{ position: "absolute", top: 0, bottom: 0, left: `${((k + 1) / (fmt.frames as number)) * 100}%`, width: 0, borderLeft: "2px dashed rgba(0,81,132,0.35)", zIndex: 5, pointerEvents: "none" }} />
            ))}
          <div style={{ transform: `scale(${previewScale})`, transformOrigin: "top left", width: baseW, height: baseH }}>
            <Slide
              kind={cur.kind}
              data={cur as CoercedSlide}
              accent={accent}
              eyebrow={eyebrow}
              cta={cta}
              baseW={baseW}
              baseH={baseH}
              idx={cur.kind === "content" ? current : 0}
              total={total}
              id="preview-slide"
              cover={cover}
              slides={slides}
              seed={seed}
              images={images}
              setImg={setImg}
              design={design}
              scale={scales[current] || 1}
              ideaMode={!!fmt.idea}
              photoOn={!!imgOn[current]}
              replay={replay}
            />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 22, flexShrink: 0 }}>
          <div onClick={() => setCurrent((c) => Math.max(0, c - 1))} style={{ cursor: "pointer", width: 40, height: 40, borderRadius: "50%", background: current === 0 ? C.line : C.white, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 10px rgba(0,40,70,.1)", fontSize: 18, color: C.ink }}>
            ‹
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {deck.map((_, i) => (
              <div key={i} onClick={() => selectDeck(i)} style={{ width: i === current ? 22 : 8, height: 8, borderRadius: 4, background: i === current ? C.blue : C.lineD, cursor: "pointer", transition: "all .2s" }} />
            ))}
          </div>
          <div onClick={() => setCurrent((c) => Math.min(deck.length - 1, c + 1))} style={{ cursor: "pointer", width: 40, height: 40, borderRadius: "50%", background: current === deck.length - 1 ? C.line : C.white, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 10px rgba(0,40,70,.1)", fontSize: 18, color: C.ink }}>
            ›
          </div>
        </div>

        {/* Horizontal Slide Deck Cards in Center */}
        <div style={{ width: "100%", maxWidth: 840, marginTop: 20, padding: "16px 20px", background: C.white, borderRadius: 14, boxShadow: "0 4px 20px rgba(0,40,70,0.08)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ ...label, marginBottom: 0, fontSize: 13 }}>
              Deck Cards · {slides.length} of {slideCap}
              {slides.length > slideCap && (
                <span style={{ color: "#B4442E", fontWeight: 700 }}> · {format} draws only the first {slideCap}</span>
              )}
              {slides.length > 3 && <span style={{ color: C.inkMute, fontWeight: 400 }}> · scroll for more →</span>}
            </span>
            <div
              onClick={atCap ? undefined : addSlide}
              title={atCap ? `${format} renders ${slideCap} ${slideCap === 1 ? "slide" : "slides"} — anything more would not be drawn.` : undefined}
              style={{ fontFamily: font, fontSize: 12.5, fontWeight: 700, color: atCap ? C.inkMute : C.blue, cursor: atCap ? "default" : "pointer", background: C.mist, padding: "5px 12px", borderRadius: 6, opacity: atCap ? 0.55 : 1 }}
            >
              + Add slide
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8 }}>
            {/* COVER CARD */}
            {(() => {
              const isCoverSelected = (cur.kind === "cover");
              return (
                <div
                  onClick={() => selectDeck(0)}
                  style={{
                    border: isCoverSelected ? `2px solid ${C.blue}` : `1px solid ${C.line}`,
                    borderRadius: 10,
                    padding: 12,
                    background: isCoverSelected ? "#F4F8FC" : C.off,
                    minWidth: 260,
                    flexShrink: 0,
                    transition: "all 0.15s ease",
                    cursor: "pointer"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontFamily: font, fontSize: 11, fontWeight: 700, color: C.blue, letterSpacing: "0.06em" }}>COVER HEADLINE</span>
                  </div>
                  <textarea
                    value={cover}
                    onChange={(e) => setCover(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    rows={4}
                    placeholder="Cover headline · mark one word *like this*"
                    style={{ ...inputStyle, fontFamily: displayFont, fontSize: 14, background: C.white }}
                  />
                </div>
              );
            })()}

            {/* CONTENT SLIDES CARDS */}
            {slides.map((s, i) => {
              const isSelected = (cur.kind === "content" && current === i + 1);
              return (
                <div 
                  key={i} 
                  onClick={() => selectDeck(i + 1)}
                  style={{ 
                    border: isSelected ? `2px solid ${C.blue}` : `1px solid ${C.line}`, 
                    borderRadius: 10, 
                    padding: 12, 
                    background: isSelected ? "#F4F8FC" : C.off, 
                    minWidth: 260, 
                    flexShrink: 0,
                    transition: "all 0.15s ease",
                    cursor: "pointer"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontFamily: font, fontSize: 11, fontWeight: 700, color: accent, letterSpacing: "0.06em" }}>SLIDE {String(i + 1).padStart(2, "0")}</span>
                    <span onClick={(e) => { e.stopPropagation(); rmSlide(i); }} style={{ fontFamily: font, fontSize: 11, color: C.inkMute, cursor: "pointer", fontWeight: 600 }}>
                      Remove
                    </span>
                  </div>
                  <input 
                    value={s.title} 
                    onChange={(e) => updSlide(i, "title", e.target.value)} 
                    onClick={(e) => e.stopPropagation()} 
                    placeholder="Slide title" 
                    style={{ ...inputStyle, marginBottom: 7, fontFamily: displayFont, fontWeight: 600, background: C.white }} 
                  />
                  <textarea 
                    value={s.body} 
                    onChange={(e) => updSlide(i, "body", e.target.value)} 
                    onClick={(e) => e.stopPropagation()} 
                    rows={3} 
                    placeholder="One idea for this slide" 
                    style={{ ...inputStyle, background: C.white }} 
                  />
                </div>
              );
            })}

            {/* CLOSING / CTA CARD */}
            {(() => {
              const isCtaSelected = (cur.kind === "end");
              const ctaIdx = deck.length - 1;
              return (
                <div
                  onClick={() => selectDeck(ctaIdx)}
                  style={{
                    border: isCtaSelected ? `2px solid ${C.blue}` : `1px solid ${C.line}`,
                    borderRadius: 10,
                    padding: 12,
                    background: isCtaSelected ? "#F4F8FC" : C.off,
                    minWidth: 260,
                    flexShrink: 0,
                    transition: "all 0.15s ease",
                    cursor: "pointer"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontFamily: font, fontSize: 11, fontWeight: 700, color: C.teal, letterSpacing: "0.06em" }}>CLOSING / CTA</span>
                  </div>
                  <textarea
                    value={cta}
                    onChange={(e) => setCta(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    rows={4}
                    placeholder="Closing message or call to action"
                    style={{ ...inputStyle, fontFamily: displayFont, fontSize: 14, background: C.white }}
                  />
                </div>
              );
            })()}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexShrink: 0, flexWrap: "wrap", justifyContent: "center", background: C.white, borderRadius: 20, padding: "6px 14px", boxShadow: "0 2px 10px rgba(0,40,70,.08)" }}>
          <span style={{ fontFamily: font, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: C.inkMute }}>Text size · this slide</span>
          <div onClick={() => bumpScale(-0.08)} style={{ cursor: "pointer", fontFamily: font, fontSize: 15, fontWeight: 800, color: C.blue, padding: "0 6px", userSelect: "none" }}>
            A−
          </div>
          <span style={{ fontFamily: font, fontSize: 12.5, fontWeight: 700, color: C.ink, width: 44, textAlign: "center" }}>{Math.round((scales[current] || 1) * 100)}%</span>
          <div onClick={() => bumpScale(0.08)} style={{ cursor: "pointer", fontFamily: font, fontSize: 17, fontWeight: 800, color: C.blue, padding: "0 6px", userSelect: "none" }}>
            A+
          </div>
          {(scales[current] || 1) !== 1 && (
            <div onClick={() => setScales((m) => ({ ...m, [current]: 1 }))} style={{ cursor: "pointer", fontFamily: font, fontSize: 12, fontWeight: 700, color: C.inkMute, userSelect: "none" }}>
              ↺ Reset
            </div>
          )}
          {/* Was gated on fmt.deck, which is why Story advertised a photo slot it could
              never show: its renderer needs photoOn and only decks could set it. The
              gate is now the same question the URL button asks — does this format have
              a photo slot at all? */}
          {photoKeyFor() && (
            <div onClick={() => setImgOn((m) => ({ ...m, [current]: !m[current] }))} style={{ cursor: "pointer", fontFamily: font, fontSize: 12, fontWeight: 700, color: imgOn[current] ? C.teal : C.inkMute, userSelect: "none", borderLeft: `1px solid ${C.line}`, paddingLeft: 10 }}>
              {imgOn[current] ? "Photo on" : "Add photo"}
            </div>
          )}
          {photoKeyFor() && (
            <div onClick={() => setUrlOpen((v) => !v)} style={{ cursor: "pointer", fontFamily: font, fontSize: 12, fontWeight: 700, color: urlOpen ? C.blue : C.inkMute, userSelect: "none", borderLeft: `1px solid ${C.line}`, paddingLeft: 10 }}>
              🔗 Image URL
            </div>
          )}
        </div>
        {urlOpen && photoKeyFor() && (
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexShrink: 0, width: "min(560px, 92%)" }}>
            <input value={urlVal} onChange={(e) => setUrlVal(e.target.value)} placeholder={fmt.single === "montage" ? "Paste an image URL — one wide photo across all three frames" : "Paste an image URL (Unsplash images import cleanly) — lands on this slide's photo slot"} style={{ flex: 1, fontFamily: font, fontSize: 12.5, color: C.ink, background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 12px", outline: "none" }} />
            <button onClick={importImageUrl} disabled={urlBusy || !urlVal.trim()} style={{ fontFamily: font, fontSize: 12, fontWeight: 700, padding: "0 16px", borderRadius: 8, cursor: urlBusy || !urlVal.trim() ? "default" : "pointer", border: "none", color: "#fff", background: C.teal, opacity: urlBusy || !urlVal.trim() ? 0.55 : 1 }}>
              {urlBusy ? "…" : "Import"}
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap", justifyContent: "center", flexShrink: 0 }}>
          {lever !== "none" && (
            <button onClick={cycleLook} style={{ fontFamily: font, fontSize: 13, fontWeight: 700, padding: "10px 18px", borderRadius: 8, cursor: "pointer", border: "none", color: "#fff", background: GRAD }}>
              🎲 Next look ·{" "}
              {lever === "cards"
                ? // Each set has its own surface now, so name it. On "mixed" the set
                  // never moves, so name the rotating surface instead — otherwise the
                  // button reads "Mixed" forever and looks stuck while the art changes.
                  design.set === "mixed"
                  ? SURFACE_LABELS[surfaceFor(design.set, seed)]
                  : (DESIGN_SETS[design.set || "editorial"] || DESIGN_SETS.editorial).label.split(" ·")[0]
                : lever === "accent"
                ? design.accent
                  ? "tinted"
                  : "auto tone"
                : (DESIGN_SETS[design.set || "editorial"] || DESIGN_SETS.editorial).label.split(" ·")[0]}
              {design.accent ? " · tinted" : ""}
            </button>
          )}
          {lever === "none" && (
            <div
              title="This format renders one fixed layout, so there are no alternative looks to cycle."
              style={{ fontFamily: font, fontSize: 12, color: C.inkMute, alignSelf: "center", padding: "10px 4px", lineHeight: 1.4 }}
            >
              {format} has a single fixed look
            </div>
          )}
          {/* A multi-page format ships two ways, and which one you want depends on how
              you are posting: a document post takes the PDF, a native image carousel
              takes the PNGs. They were one button doing both, which wrote files nobody
              asked for. Every format that can produce the PDF now offers both. */}
          {docCapable && (
            <button
              onClick={handleExportDocPdf}
              disabled={!!pdfBusy || exportBusy}
              title={`A ${docPages}-page PDF — the file LinkedIn document posts upload directly`}
              style={{ fontFamily: font, fontSize: 13, fontWeight: 700, padding: "10px 18px", borderRadius: 8, cursor: pdfBusy || exportBusy ? "default" : "pointer", border: "none", color: "#fff", background: GRAD, opacity: pdfBusy || exportBusy ? 0.7 : 1 }}
            >
              {pdfBusy ? `Building PDF · ${fmt.frames ? "frame" : "slide"} ${pdfBusy}/${docPages}…` : `⬇ LinkedIn PDF · ${docPages} pages`}
            </button>
          )}
          {docCapable && (
            <button
              onClick={handleExportPngSet}
              disabled={exportBusy || !!pdfBusy}
              title={`The same ${docPages} ${fmt.frames ? "frames" : "slides"} as separate PNGs, for a native image carousel`}
              style={{ fontFamily: font, fontSize: 13, fontWeight: 700, padding: "10px 18px", borderRadius: 8, cursor: exportBusy || pdfBusy ? "default" : "pointer", border: "none", color: "#fff", background: C.blue, opacity: exportBusy || pdfBusy ? 0.6 : 1 }}
            >
              {exportBusy ? "Saving PNGs…" : `⬇ LinkedIn PNGs · ${pngFiles} files`}
            </button>
          )}
          {/* Framed formats have no single slide to download — the frames button above
              already writes every one of them. */}
          {!fmt.frames && (
            <button
              onClick={() => handleExportPNG(current)}
              disabled={exportBusy}
              style={{ fontFamily: font, fontSize: 13, fontWeight: 700, padding: "10px 18px", borderRadius: 8, cursor: exportBusy ? "default" : "pointer", border: `1.5px solid ${C.blue}`, color: C.blue, background: "transparent", opacity: exportBusy ? 0.6 : 1 }}
            >
              {fmt.single === "video" ? "Download poster PNG" : docCapable ? "Download this slide only" : "Download this slide"}
            </button>
          )}
          {fmt.deck && (
            <button onClick={handleExportStrip} disabled={exportBusy} style={{ fontFamily: font, fontSize: 13, fontWeight: 700, padding: "10px 18px", borderRadius: 8, cursor: exportBusy ? "default" : "pointer", border: `1.5px solid ${C.blue}`, color: C.blue, background: "transparent", opacity: exportBusy ? 0.6 : 1 }}>
              🧵 Review strip
            </button>
          )}
          {fmt.frames && (
            <button onClick={handleExportPanorama} disabled={exportBusy} style={{ fontFamily: font, fontSize: 13, fontWeight: 700, padding: "10px 18px", borderRadius: 8, cursor: exportBusy ? "default" : "pointer", border: `1.5px solid ${C.blue}`, color: C.blue, background: "transparent", opacity: exportBusy ? 0.6 : 1 }}>
              🖼 Panorama · one image
            </button>
          )}
          <button
            onClick={() => setPreviewOpen(true)}
            title="See this in a LinkedIn, Instagram or X feed before you post it"
            style={{ fontFamily: font, fontSize: 13, fontWeight: 700, padding: "10px 18px", borderRadius: 8, cursor: "pointer", border: `1.5px solid ${C.blue}`, color: C.blue, background: "transparent" }}
          >
            👁 Preview in feed
          </button>
        </div>
        <div style={{ fontFamily: font, fontSize: 11, color: C.inkMute, marginTop: 12, maxWidth: 380, textAlign: "center", lineHeight: 1.5 }}>
          PNGs export at full size, with the Fraunces/Open Sans font files embedded so they render correctly outside the browser. A Design set holds ONE layout across the whole deck. &quot;Next look&quot; cycles 30 uniform looks (6 sets × 5 accent tones); pick a set or accent directly in Design elements to pin it. Photo slots appear on Carousel, Square, Article, Story and Montage — click “Add photo”, then click the slot to upload or use “Image URL”. Montage slices into carousel frames (dashed lines show the cuts). Multi-page formats — Carousel, Square, Idea Deck and Montage — offer the same content two ways: &quot;LinkedIn PDF&quot; is the file a document post uploads directly, one page per slide (per frame on Montage), and &quot;LinkedIn PNGs&quot; is the same set as separate images for a native carousel. &quot;Review strip&quot; is a half-size single image for quick sharing.
        </div>
      </div>

      <SocialPreview
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        formatLabel={format}
        baseW={baseW}
        baseH={baseH}
        frames={fmt.frames}
        pages={previewPages}
        shared={{
          accent,
          eyebrow,
          cta,
          baseW,
          baseH,
          total,
          cover,
          slides,
          seed,
          images,
          setImg,
          design,
          ideaMode: !!fmt.idea
        }}
        caption={previewCaption}
        onCaptionChange={(v) => {
          captionTouched.current = true;
          setPreviewCaption(v);
        }}
        authorName={session?.user?.name}
        authorEmail={session?.user?.email}
      />

      {/* hidden full-resolution renders used for export */}
      <div style={{ position: "absolute", left: -99999, top: 0, pointerEvents: "none" }} aria-hidden>
        {deck.map((d, i) => (
          <Slide
            key={i}
            id={`exp-${i}`}
            kind={d.kind}
            data={d as CoercedSlide}
            accent={accent}
            eyebrow={eyebrow}
            cta={cta}
            baseW={baseW}
            baseH={baseH}
            idx={d.kind === "content" ? i : 0}
            total={total}
            cover={cover}
            slides={slides}
            seed={seed}
            images={images}
            setImg={setImg}
            design={design}
            scale={scales[i] || 1}
            ideaMode={!!fmt.idea}
            photoOn={!!imgOn[i]}
            replay={replay}
          />
        ))}
      </div>
    </div>
  );
}
