"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { jsPDF } from "jspdf";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

type Cut = {
  id: string;
  name: string;
  line: number;
  trimRows?: number;
  frames?: number;
  manual?: boolean;
};
type Section = { start: number; end: number; name: string; frames: number };
type SceneDivider = { id: string; line: number; color: string; text: string };
type VoicevoxStyle = { id: number; name: string; speaker: string };
type HistorySnapshot = {
  action: string;
  dialogue: string;
  sceneText: string;
  firstCutName: string;
  cuts: Cut[];
  sceneDividers: SceneDivider[];
  focusSide: "scene" | "action" | "dialogue" | null;
  selectionStart: number;
  selectionEnd: number;
  workspaceScrollTop: number;
  workspaceScrollLeft: number;
};
type ExportKind =
  | "project"
  | "pdf"
  | "xdts"
  | "storyboard"
  | "srt"
  | "voicevox"
  | "wav"
  | "movie"
  | null;
const FPS = 24;
const colors = [
  "#d84f4f",
  "#477fd1",
  "#4d9b59",
  "#c98235",
  "#9657bd",
  "#35999d",
  "#c65a88",
  "#6f6f6f",
];
const sampleA = `○ 廃校・教室／夕方\n\n窓から差す橙色の光。机の上には古いカセットテープ。\n\nミナが扉の前で立ち止まる。`;
const sampleD = `\n\n\n[ミナ]ここに、まだ残ってたんだ。\n\n[レン]再生してみよう。きっと答えが入ってる。`;

function readingFrames(text: string, cps: number) {
  let units = 0,
    fixed = 0;
  const source = text.replace(/^[ \t　]*[［\[][^\]］]+[\]］]/gm, "");
  const blankOnly = source.trim() === "";
  // Empty grid rows are a fixed six frames each. Do not let whitespace in
  // those rows add speech-speed-dependent or punctuation timing on top.
  if (blankOnly) return source.split("\n").length * 6;
  for (const ch of source) {
    if (ch === "\n") fixed += 6;
    else if (
      ch === " " ||
      ch === "　" ||
      ch === "、" ||
      ch === "，" ||
      ch === ","
    )
      fixed += 3;
    else if ("。！？!?…".includes(ch)) fixed += 6;
    else if (
      "「」『』（）()".includes(ch) ||
      "ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ".includes(ch)
    )
      continue;
    else if (/[一-龠々]/.test(ch)) units += 2.2;
    else if (/[A-Za-z0-9]/.test(ch)) units += 0.8;
    else units += 1;
  }
  return Math.max(0, Math.round((units / Math.max(0.1, cps)) * FPS) + fixed);
}
const plus = (f: number) => `${Math.floor(f / FPS)}+${f % FPS}`;
const parseDurationFrames = (value: string) => {
  const normalized = value
    .trim()
    .replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    )
    .replaceAll("＋", "+");
  const match = normalized.match(/^(\d+)(?:\+(\d+))?$/);
  if (!match) return null;
  return match[2] == null
    ? Number(match[1])
    : Number(match[1]) * FPS + Number(match[2]);
};
const runtime = (f: number) => {
  const s = Math.floor(f / FPS);
  return `${Math.floor(s / 60)}分${s % 60}秒${f % FPS}コマ`;
};
const safe = (s: string) =>
  s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 70) || "dialogue";
const xdtsCut = (name: string) => {
  const m = String(name).match(/^(\d+)(.*)$/);
  return m ? `${m[1].padStart(3, "0")}${m[2]}` : safe(name);
};
const parseDialogue = (line: string) => {
  const m = line.match(/^\s*[［\[]([^\]］]+)[\]］]\s*(.*)$/);
  return m ? { speaker: m[1].trim(), body: m[2].trim() } : null;
};
const download = (
  name: string,
  body: BlobPart,
  type = "text/plain;charset=utf-8",
) => {
  const url = URL.createObjectURL(new Blob([body], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const saveToChosenLocation = async (
  name: string,
  body: BlobPart,
  type = "text/plain;charset=utf-8",
) => {
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName: string;
        types: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<{
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    }
  ).showSaveFilePicker;
  if (!picker) {
    download(name, body, type);
    return;
  }
  try {
    const handle = await picker({
        suggestedName: name,
        types: [
          {
            description: "Storyboard Script Organizer 作業データ",
            accept: { "application/json": [".json"] },
          },
        ],
      }),
      writable = await handle.createWritable();
    await writable.write(new Blob([body], { type }));
    await writable.close();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    download(name, body, type);
  }
};
const boxLines = (
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
) => {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const ch of paragraph) {
      if (ctx.measureText(line + ch).width > width && line) {
        out.push(line);
        line = ch;
      } else line += ch;
    }
    if (line) out.push(line);
    else if (paragraph === "") out.push("");
  }
  return out;
};
const drawBoxText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  maxFont: number,
  color: string,
) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  let size = maxFont,
    lines: string[] = [],
    lineHeight = 0;
  while (size >= 11) {
    ctx.font = `${size}px "Yu Gothic UI",sans-serif`;
    lineHeight = Math.ceil(size * 1.55);
    lines = boxLines(ctx, text, width);
    if (lines.length * lineHeight <= height) break;
    size--;
  }
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `${size}px "Yu Gothic UI",sans-serif`;
  lines
    .slice(0, Math.floor(height / lineHeight))
    .forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
  ctx.restore();
};
const drawVertical = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  maxFont: number,
  color: string,
) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  let size = maxFont,
    step = 0,
    perCol = 0,
    cols: string[] = [];
  while (size >= 11) {
    step = Math.ceil(size * 1.22);
    perCol = Math.max(1, Math.floor(height / step));
    cols = [];
    for (const p of text.split("\n")) {
      for (let i = 0; i < p.length; i += perCol)
        cols.push(p.slice(i, i + perCol));
      cols.push("");
    }
    if (cols.length * step <= width) break;
    size--;
  }
  ctx.font = `${size}px "Yu Gothic UI",sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let cx = x + width - step / 2;
  for (const col of cols) {
    if (cx < x) break;
    for (let i = 0; i < col.length; i++) ctx.fillText(col[i], cx, y + i * step);
    cx -= step;
  }
  ctx.restore();
};

export default function Home() {
  const [action, setAction] = useState(sampleA),
    [dialogue, setDialogue] = useState(sampleD),
    [sceneText, setSceneText] = useState(""),
    [sceneDividers, setSceneDividers] = useState<SceneDivider[]>([]),
    [cps, setCps] = useState(8),
    [mode, setMode] = useState<"frames" | "seconds">("frames"),
    [firstCutName, setFirstCutName] = useState("1"),
    [cuts, setCuts] = useState<Cut[]>([
      { id: "cut-1", name: "2", line: 5, trimRows: 0 },
    ]),
    [fontSize, setFontSize] = useState(15),
    [menu, setMenu] = useState(false),
    [busy, setBusy] = useState(""),
    [fileDragActive, setFileDragActive] = useState(false),
    [dragId, setDragId] = useState<string | null>(null),
    [resizeId, setResizeId] = useState<string | null>(null),
    [exportKind, setExportKind] = useState<ExportKind>(null),
    [exportName, setExportName] = useState("storyboard"),
    [movieDialogueBold, setMovieDialogueBold] = useState(false),
    [includeAction, setIncludeAction] = useState(false),
    [gridCount, setGridCount] = useState(6),
    [split, setSplit] = useState(50),
    [speakerColors, setSpeakerColors] = useState<Record<string, string>>({}),
    [importSettingsOpen, setImportSettingsOpen] = useState(false),
    [dialoguePatterns, setDialoguePatterns] = useState(["A「B」", "A『B』"]),
    [patternDraft, setPatternDraft] = useState(""),
    [breakComma, setBreakComma] = useState(false),
    [breakPeriod, setBreakPeriod] = useState(false),
    [breakMarks, setBreakMarks] = useState(false),
    [breakEllipsis, setBreakEllipsis] = useState(false),
    [selectedCutIds, setSelectedCutIds] = useState<Set<string>>(new Set()),
    [editingDurationId, setEditingDurationId] = useState<string | null>(null),
    [durationDraft, setDurationDraft] = useState(""),
    [editingCutNameId, setEditingCutNameId] = useState<string | null>(null),
    [cutNameDraft, setCutNameDraft] = useState(""),
    [sceneDragId, setSceneDragId] = useState<string | null>(null),
    [sceneWidth, setSceneWidth] = useState(190),
    [sceneWidthDragging, setSceneWidthDragging] = useState(false),
    [splitDragging, setSplitDragging] = useState(false),
    [speaking, setSpeaking] = useState(false),
    [playbackOpen, setPlaybackOpen] = useState(false),
    [voicevoxHelpOpen, setVoicevoxHelpOpen] = useState(false),
    [playbackRate, setPlaybackRate] = useState(1),
    [syncPlaybackRate, setSyncPlaybackRate] = useState(true),
    [speakerPitch, setSpeakerPitch] = useState<Record<string, number>>({}),
    [playbackEngine, setPlaybackEngine] = useState<"browser" | "voicevox">(
      "browser",
    ),
    [voicevoxUrl, setVoicevoxUrl] = useState("http://127.0.0.1:50021"),
    [voicevoxStatus, setVoicevoxStatus] = useState("未接続"),
    [voicevoxStyles, setVoicevoxStyles] = useState<VoicevoxStyle[]>([]),
    [voicevoxSpeakerStyles, setVoicevoxSpeakerStyles] = useState<
      Record<string, number>
    >({});
  const fileRef = useRef<HTMLInputElement>(null),
    cutLayerRef = useRef<HTMLDivElement>(null),
    workspaceRef = useRef<HTMLElement>(null),
    actionRef = useRef<HTMLTextAreaElement>(null),
    dialogueRef = useRef<HTMLTextAreaElement>(null),
    sceneRef = useRef<HTMLTextAreaElement>(null),
    scenePanelRef = useRef<HTMLDivElement>(null),
    dialogueEnterRef = useRef<{
      speaker: string;
      inherit: boolean;
    } | null>(null),
    pendingSelectionRef = useRef<{
      side: "scene" | "action" | "dialogue";
      position: number;
      end?: number;
      scrollTop: number;
      scrollLeft: number;
      workspaceScrollTop: number;
      workspaceScrollLeft: number;
    } | null>(null),
    playbackRunRef = useRef(0),
    playbackSelectionRef = useRef<{ start: number; end: number } | null>(null),
    voicevoxAudioRef = useRef<HTMLAudioElement | null>(null),
    voicevoxObjectUrlRef = useRef<string | null>(null),
    historyRef = useRef<HistorySnapshot[]>([]),
    historyIndexRef = useRef(-1),
    historyGroupRef = useRef<{ kind: "text" | "cuts"; at: number } | null>(
      null,
    ),
    dragAnchorLine = useRef(0),
    dragStartLines = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    const target =
      pending.side === "scene"
        ? sceneRef.current
        : pending.side === "action"
          ? actionRef.current
          : dialogueRef.current;
    if (!target) return;
    const position = Math.min(target.value.length, pending.position);
    target.focus({ preventScroll: true });
    target.setSelectionRange(
      position,
      Math.min(target.value.length, pending.end ?? position),
    );
    target.scrollTop = pending.scrollTop;
    target.scrollLeft = pending.scrollLeft;
    if (workspaceRef.current) {
      workspaceRef.current.scrollTop = pending.workspaceScrollTop;
      workspaceRef.current.scrollLeft = pending.workspaceScrollLeft;
    }
    pendingSelectionRef.current = null;
  }, [action, dialogue, sceneText]);
  useEffect(() => {
    const active = document.activeElement,
      focusSide =
        active === sceneRef.current
          ? "scene"
          : active === actionRef.current
          ? "action"
          : active === dialogueRef.current
            ? "dialogue"
            : null,
      focusTarget =
        focusSide === "scene"
          ? sceneRef.current
          : focusSide === "action"
          ? actionRef.current
          : focusSide === "dialogue"
            ? dialogueRef.current
            : null,
      snapshot: HistorySnapshot = {
        action,
        dialogue,
        sceneText,
        firstCutName,
        cuts: cuts.map((cut) => ({ ...cut })),
        sceneDividers: sceneDividers.map((divider) => ({ ...divider })),
        focusSide,
        selectionStart: focusTarget?.selectionStart ?? 0,
        selectionEnd: focusTarget?.selectionEnd ?? 0,
        workspaceScrollTop: workspaceRef.current?.scrollTop ?? 0,
        workspaceScrollLeft: workspaceRef.current?.scrollLeft ?? 0,
      },
      history = historyRef.current,
      current = history[historyIndexRef.current];
    if (
      current &&
      current.action === action &&
      current.dialogue === dialogue &&
      current.sceneText === sceneText &&
      current.firstCutName === firstCutName &&
      JSON.stringify(current.cuts) === JSON.stringify(cuts) &&
      JSON.stringify(current.sceneDividers) === JSON.stringify(sceneDividers)
    )
      return;
    const kind: "text" | "cuts" =
        current &&
        (current.action !== action ||
          current.dialogue !== dialogue ||
          current.sceneText !== sceneText)
          ? "text"
          : "cuts",
      now = performance.now(),
      group = historyGroupRef.current,
      canGroup =
        historyIndexRef.current === history.length - 1 &&
        group?.kind === kind &&
        now - group.at < 350;
    if (canGroup && history.length > 1) {
      history[historyIndexRef.current] = snapshot;
    } else {
      const next = history.slice(0, historyIndexRef.current + 1);
      next.push(snapshot);
      if (next.length > 200) next.shift();
      historyRef.current = next;
      historyIndexRef.current = next.length - 1;
    }
    historyGroupRef.current = { kind, at: now };
  }, [action, dialogue, sceneText, firstCutName, cuts, sceneDividers]);
  const lines = Math.max(
      action.split("\n").length,
      dialogue.split("\n").length,
      1,
    ),
    sceneLines = Math.max(
      sceneText.split("\n").length,
      ...sceneDividers.map((divider) => divider.line + 2),
      1,
    ),
    sceneDisplayLines = Math.max(
      sceneLines,
      lines,
      Math.ceil(560 / (fontSize * 1.55)),
    ),
    actionLines = action.split("\n"),
    dialogueLines = dialogue.split("\n");
  const sortedCuts = useMemo(
    () => [...cuts].sort((a, b) => a.line - b.line),
    [cuts],
  );
  const sections = useMemo<Section[]>(() => {
    const marks = [0, ...sortedCuts.map((c) => c.line), lines],
      isTrimmed = (row: number) =>
        sortedCuts.some(
          (c) => row >= c.line && row < c.line + (c.trimRows ?? 0),
        ),
      // Calculate each automatic cut from cumulative script timing. This
      // keeps the newline at a cut boundary (six frames) and also prevents
      // per-cut rounding from changing the total when a divider is added.
      cumulativeFrames = new Map(
        marks.map((mark) => {
          const text = dialogueLines
            .slice(0, mark)
            .filter((_, row) => !isTrimmed(row))
            .join("\n");
          return [mark, text === "" && mark === 0 ? 0 : readingFrames(text, cps)];
        }),
      );
    return marks.slice(0, -1).map((start, i) => {
      const cut = i ? sortedCuts[i - 1] : undefined,
        endCut = sortedCuts[i],
        end = marks[i + 1],
        auto = Math.max(
          0,
          (cumulativeFrames.get(end) ?? 0) -
            (cumulativeFrames.get(start) ?? 0),
        );
      return {
        start,
        end,
        name: i ? (cut?.name ?? String(i + 1)) : firstCutName,
        frames: endCut?.manual && endCut.frames != null ? endCut.frames : auto,
      };
    });
  }, [sortedCuts, lines, dialogue, cps, firstCutName]);
  const total = sections.reduce((n, s) => n + s.frames, 0);
  const speakers = useMemo(() => {
    const list: string[] = [];
    dialogueLines.forEach((l) => {
      const p = parseDialogue(l);
      if (p && !list.includes(p.speaker)) list.push(p.speaker);
    });
    return list;
  }, [dialogue]);

  const sync = (
    side: "action" | "dialogue",
    value: string,
    caret: number | null,
  ) => {
    const oldValue = side === "action" ? action : dialogue,
      oldLines = oldValue.split("\n"),
      own = value.split("\n"),
      delta = own.length - oldLines.length;
    let changed = 0;
    while (
      changed < Math.min(oldLines.length, own.length) &&
      oldLines[changed] === own[changed]
    )
      changed++;
    let caretShift = 0;
    if (side === "dialogue" && delta > 0) {
      const enter = dialogueEnterRef.current,
        targetRow = value.slice(0, caret ?? 0).split("\n").length - 1;
      if (
        enter?.inherit &&
        enter.speaker &&
        own[targetRow]?.trim() &&
        !parseDialogue(own[targetRow])
      ) {
        const tag = `[${enter.speaker}]`;
        own[targetRow] = tag + own[targetRow].trimStart();
        caretShift = tag.length;
      }
      dialogueEnterRef.current = null;
    }
    if (delta !== 0)
      setCuts((current) => {
        const shifted = current.map((cut) =>
            cut.line > changed
              ? {
                  ...cut,
                  line: Math.max(1, changed, cut.line + delta),
                }
              : cut,
          ),
          byLine = new Map<number, Cut>();
        for (const cut of shifted) {
          const existing = byLine.get(cut.line);
          byLine.set(
            cut.line,
            existing
              ? {
                  ...existing,
                  trimRows: Math.max(existing.trimRows ?? 0, cut.trimRows ?? 0),
                }
              : cut,
          );
        }
        return [...byLine.values()].sort((a, b) => a.line - b.line);
      });
    const other = (side === "action" ? dialogue : action).split("\n");
    if (delta > 0) other.splice(changed, 0, ...Array(delta).fill(""));
    else if (delta < 0) other.splice(changed, -delta);
    while (other.length < own.length) other.push("");
    const next = own.join("\n");
    if (side === "action") {
      setAction(next);
      setDialogue(other.join("\n"));
    } else {
      setDialogue(next);
      setAction(other.join("\n"));
    }
    if (caret != null) {
      const target = side === "action" ? actionRef.current : dialogueRef.current;
      pendingSelectionRef.current = {
        side,
        position: caret + caretShift,
        scrollTop: target?.scrollTop ?? 0,
        scrollLeft: target?.scrollLeft ?? 0,
        workspaceScrollTop: workspaceRef.current?.scrollTop ?? 0,
        workspaceScrollLeft: workspaceRef.current?.scrollLeft ?? 0,
      };
    }
  };
  const syncScene = (value: string, caret: number | null) => {
    const oldRows = sceneText.split("\n"),
      nextRows = value.split("\n"),
      delta = nextRows.length - oldRows.length;
    let changed = 0;
    while (
      changed < Math.min(oldRows.length, nextRows.length) &&
      oldRows[changed] === nextRows[changed]
    )
      changed++;
    if (delta) {
      setSceneDividers((current) =>
        current.map((divider) =>
          divider.line > changed
            ? { ...divider, line: Math.max(0, divider.line + delta) }
            : divider,
        ),
      );
    }
    setSceneText(nextRows.join("\n"));
    if (caret != null)
      pendingSelectionRef.current = {
        side: "scene",
        position: caret,
        scrollTop: sceneRef.current?.scrollTop ?? 0,
        scrollLeft: sceneRef.current?.scrollLeft ?? 0,
        workspaceScrollTop: workspaceRef.current?.scrollTop ?? 0,
        workspaceScrollLeft: workspaceRef.current?.scrollLeft ?? 0,
      };
  };
  const normalize = () => {
    setFirstCutName("1");
    setCuts((v) =>
      [...v]
        .sort((a, b) => a.line - b.line)
        .map((c, i) => ({ ...c, name: String(i + 2) })),
    );
  };
  const startCutNameEdit = (id: string, name: string) => {
    setEditingCutNameId(id);
    setCutNameDraft(name);
  };
  const commitCutName = () => {
    const id = editingCutNameId,
      name = cutNameDraft.trim();
    setEditingCutNameId(null);
    if (!id || !name) return;
    const entries = [
      { id: "first-cut", name: id === "first-cut" ? name : firstCutName },
      ...sortedCuts.map((cut) => ({
        id: cut.id,
        name: cut.id === id ? name : cut.name,
      })),
    ];
    const duplicates = entries.filter((entry) => entry.name === name);
    const renamed = new Map<string, string>();
    if (duplicates.length > 1)
      duplicates.forEach((entry, index) =>
        renamed.set(entry.id, `${name}${String.fromCharCode(65 + index)}`),
      );
    else renamed.set(id, name);
    setFirstCutName(renamed.get("first-cut") ?? entries[0].name);
    setCuts((current) =>
      current.map((cut) => ({
        ...cut,
        name: renamed.get(cut.id) ??
          entries.find((entry) => entry.id === cut.id)?.name ??
          cut.name,
      })),
    );
  };
  const applyHistory = (nextIndex: number) => {
    const history = historyRef.current,
      snapshot = history[nextIndex];
    if (!snapshot) return;
    historyIndexRef.current = nextIndex;
    historyGroupRef.current = null;
    playbackRunRef.current += 1;
    speechSynthesis.cancel();
    setSpeaking(false);
    setAction(snapshot.action);
    setDialogue(snapshot.dialogue);
    setSceneText(snapshot.sceneText ?? "");
    setFirstCutName(snapshot.firstCutName ?? "1");
    setCuts(snapshot.cuts.map((cut) => ({ ...cut })));
    setSceneDividers(
      (snapshot.sceneDividers ?? []).map((divider) => ({ ...divider })),
    );
    if (snapshot.focusSide) {
      const target =
        snapshot.focusSide === "scene"
          ? sceneRef.current
          : snapshot.focusSide === "action"
            ? actionRef.current
            : dialogueRef.current;
      pendingSelectionRef.current = {
        side: snapshot.focusSide,
        position: snapshot.selectionStart,
        end: snapshot.selectionEnd,
        scrollTop: target?.scrollTop ?? 0,
        scrollLeft: target?.scrollLeft ?? 0,
        workspaceScrollTop: snapshot.workspaceScrollTop,
        workspaceScrollLeft: snapshot.workspaceScrollLeft,
      };
    }
  };
  const handleHistoryKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.nativeEvent.isComposing)
      return;
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase(),
      undo = key === "z" && !e.shiftKey,
      redo = key === "y" || (key === "z" && e.shiftKey);
    if (!undo && !redo) return;
    e.preventDefault();
    applyHistory(
      historyIndexRef.current + (redo ? 1 : -1),
    );
  };
  const addCut = (line: number) =>
    setCuts((v) => {
      if (v.some((c) => c.line === line)) return v;
      const ordered = [...v].sort((a, b) => a.line - b.line),
        insert = ordered.filter((c) => c.line < line).length,
        prevName = insert === 0 ? "1" : ordered[insert - 1].name;
      let before = prevName + "A",
        after = prevName + "B";
      const m = prevName.match(/^(.*?)([A-Z])$/);
      if (m) {
        before = prevName;
        after =
          m[1] + String.fromCharCode(Math.min(90, m[2].charCodeAt(0) + 1));
      }
      if (insert > 0)
        ordered[insert - 1] = { ...ordered[insert - 1], name: before };
      if (insert === ordered.length) {
        const numeric = Number.parseInt(prevName, 10);
        before = prevName;
        after = String(Number.isFinite(numeric) ? numeric + 1 : insert + 2);
        if (insert > 0)
          ordered[insert - 1] = { ...ordered[insert - 1], name: before };
      }
      return [
        ...ordered,
        { id: crypto.randomUUID(), name: after, line, trimRows: 0 },
      ].sort((a, b) => a.line - b.line);
    });
  const moveCuts = (id: string, line: number) =>
    setCuts((v) => {
      const moving = v.find((c) => c.id === id);
      if (!moving) return v;
      const ids = selectedCutIds.has(id) ? selectedCutIds : new Set([id]),
        delta = line - dragAnchorLine.current,
        occupied = new Set(v.filter((c) => !ids.has(c.id)).map((c) => c.line));
      return v
        .map((c) => {
          if (!ids.has(c.id)) return c;
          const start = dragStartLines.current.get(c.id) ?? c.line,
            next = Math.max(1, Math.min(lines - 1, start + delta));
          return occupied.has(next) ? c : { ...c, line: next, manual: false };
        })
        .sort((a, b) => a.line - b.line);
    });
  const dragMove = (e: React.PointerEvent) => {
    if ((!dragId && !resizeId) || !cutLayerRef.current) return;
    const rect = cutLayerRef.current.getBoundingClientRect(),
      row = Math.max(
        1,
        Math.min(
          lines - 1,
          Math.floor((e.clientY - rect.top - 42) / (fontSize * 1.55)),
        ),
      );
    if (dragId) moveCuts(dragId, row);
    if (resizeId)
      setCuts((v) =>
        v.map((c) =>
          c.id === resizeId ? { ...c, trimRows: Math.max(0, row - c.line) } : c,
        ),
      );
  };
  const resizeColumns = (e: React.PointerEvent) => {
    if (!splitDragging || !workspaceRef.current) return;
    const panels = workspaceRef.current.querySelectorAll<HTMLElement>(
        ".editor-panel",
      ),
      actionRect = panels[0]?.getBoundingClientRect(),
      dialogueRect = panels[1]?.getBoundingClientRect();
    if (!actionRect || !dialogueRect) return;
    const usable = Math.max(1, dialogueRect.right - actionRect.left - 8),
      left = e.clientX - actionRect.left;
    setSplit(Math.max(25, Math.min(75, (left / usable) * 100)));
  };
  const resizeSceneColumn = (e: React.PointerEvent) => {
    if (!sceneWidthDragging || !scenePanelRef.current) return;
    const rect = scenePanelRef.current.getBoundingClientRect();
    setSceneWidth(Math.max(120, Math.min(520, e.clientX - rect.left)));
  };
  const stopVoicevoxAudio = () => {
    voicevoxAudioRef.current?.pause();
    voicevoxAudioRef.current = null;
    if (voicevoxObjectUrlRef.current) {
      URL.revokeObjectURL(voicevoxObjectUrlRef.current);
      voicevoxObjectUrlRef.current = null;
    }
  };
  const connectVoicevox = async () => {
    const base = voicevoxUrl.trim().replace(/\/+$/, "");
    setVoicevoxStatus("接続中…");
    try {
      const response = await fetch(`${base}/speakers`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const values = (await response.json()) as {
        name: string;
        styles: { id: number; name: string }[];
      }[];
      const styles = values.flatMap((voice) =>
        voice.styles.map((style) => ({
          id: style.id,
          name: style.name,
          speaker: voice.name,
        })),
      );
      if (!styles.length) throw new Error("話者が見つかりません");
      setVoicevoxStyles(styles);
      setVoicevoxSpeakerStyles((current) => {
        const next = { ...current };
        for (const speaker of speakers)
          if (next[speaker] == null) next[speaker] = styles[0].id;
        return next;
      });
      setVoicevoxStatus(`接続済み（${styles.length}スタイル）`);
      setPlaybackEngine("voicevox");
    } catch (error) {
      setVoicevoxStyles([]);
      setPlaybackEngine("browser");
      setVoicevoxStatus(
        `接続失敗：${error instanceof Error ? error.message : "VOICEVOXを確認してください"}`,
      );
    }
  };
  const toggleSpeech = () => {
    const restoreSelection = () => {
      const selection = playbackSelectionRef.current,
        target = dialogueRef.current;
      playbackSelectionRef.current = null;
      if (!selection || !target) return;
      target.focus({ preventScroll: true });
      target.setSelectionRange(selection.start, selection.end);
    };
    if (speaking) {
      playbackRunRef.current += 1;
      speechSynthesis.cancel();
      stopVoicevoxAudio();
      setSpeaking(false);
      restoreSelection();
      return;
    }
    const cursor = dialogueRef.current?.selectionStart ?? 0,
      originalEnd = dialogueRef.current?.selectionEnd ?? cursor,
      before = dialogue.slice(0, cursor),
      activeBefore = [...before.matchAll(/^\s*[［\[]([^\]］]+)[\]］]/gm)].at(
        -1,
      )?.[1],
      remaining = dialogue.slice(cursor).split("\n"),
      startRow = before.split("\n").length - 1,
      queue: (
        | { speaker: string; body: string; start: number; end: number }
        | { pauseFrames: number }
      )[] = [];
    let activeSpeaker = activeBefore ?? "",
      absoluteStart = cursor;
    for (let offset = 0; offset < remaining.length; offset++) {
      const line = remaining[offset],
        lineStart = absoluteStart,
        row = startRow + offset,
        trimmed = sortedCuts.some(
          (cut) => row >= cut.line && row < cut.line + (cut.trimRows ?? 0),
        );
      absoluteStart += line.length + (offset < remaining.length - 1 ? 1 : 0);
      if (trimmed) continue;
      const parsed = parseDialogue(line);
      if (parsed) {
        activeSpeaker = parsed.speaker;
        if (parsed.body) {
          const prefix = line.match(/^\s*[［\[][^\]］]+[\]］]\s*/)?.[0]
              .length ?? 0,
            start = lineStart + prefix;
          queue.push({
            speaker: parsed.speaker,
            body: parsed.body,
            start,
            end: start + parsed.body.length,
          });
        }
      } else if (line.trim()) {
        const body = line.trim(),
          leading = line.length - line.trimStart().length,
          start = lineStart + leading;
        queue.push({
          speaker: activeSpeaker,
          body,
          start,
          end: start + body.length,
        });
      } else queue.push({ pauseFrames: 6 });
    }
    while (queue.length && "pauseFrames" in queue.at(-1)!) queue.pop();
    if (!queue.some((item) => "body" in item)) return;
    playbackSelectionRef.current = { start: cursor, end: originalEnd };
    const run = ++playbackRunRef.current;
    speechSynthesis.cancel();
    stopVoicevoxAudio();
    setSpeaking(true);
    const playNext = async (index: number) => {
      if (run !== playbackRunRef.current) return;
      if (index >= queue.length) {
        setSpeaking(false);
        restoreSelection();
        return;
      }
      const item = queue[index];
      if ("pauseFrames" in item) {
        window.setTimeout(
          () => playNext(index + 1),
          (item.pauseFrames / FPS) * 1000,
        );
        return;
      }
      const target = dialogueRef.current;
      target?.focus({ preventScroll: true });
      target?.setSelectionRange(item.start, item.end);
      if (playbackEngine === "voicevox") {
        const styleId =
          voicevoxSpeakerStyles[item.speaker] ?? voicevoxStyles[0]?.id;
        if (styleId == null) {
          setSpeaking(false);
          restoreSelection();
          window.alert("VOICEVOXへ接続し、話者スタイルを設定してください。");
          return;
        }
        try {
          const base = voicevoxUrl.trim().replace(/\/+$/, ""),
            queryResponse = await fetch(
              `${base}/audio_query?text=${encodeURIComponent(item.body)}&speaker=${styleId}`,
              { method: "POST" },
            );
          if (!queryResponse.ok)
            throw new Error(`音声クエリ HTTP ${queryResponse.status}`);
          const query = (await queryResponse.json()) as Record<string, unknown>;
          query.speedScale = Math.max(
            0.5,
            Math.min(2, playbackRate * (syncPlaybackRate ? cps / 8 : 1)),
          );
          const audioResponse = await fetch(
            `${base}/synthesis?speaker=${styleId}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(query),
            },
          );
          if (!audioResponse.ok)
            throw new Error(`音声合成 HTTP ${audioResponse.status}`);
          if (run !== playbackRunRef.current) return;
          const objectUrl = URL.createObjectURL(await audioResponse.blob()),
            audio = new Audio(objectUrl);
          voicevoxObjectUrlRef.current = objectUrl;
          voicevoxAudioRef.current = audio;
          audio.onended = () => {
            stopVoicevoxAudio();
            void playNext(index + 1);
          };
          audio.onerror = () => {
            stopVoicevoxAudio();
            setSpeaking(false);
            restoreSelection();
          };
          await audio.play();
        } catch (error) {
          if (run !== playbackRunRef.current) return;
          stopVoicevoxAudio();
          setSpeaking(false);
          restoreSelection();
          window.alert(
            `VOICEVOXで再生できませんでした。\n${error instanceof Error ? error.message : "接続を確認してください"}`,
          );
        }
        return;
      }
      const utterance = new SpeechSynthesisUtterance(item.body);
      utterance.lang = "ja-JP";
      utterance.pitch = speakerPitch[item.speaker] ?? 1;
      utterance.rate = Math.max(
        0.5,
        Math.min(2, playbackRate * (syncPlaybackRate ? cps / 8 : 1)),
      );
      utterance.onend = () => void playNext(index + 1);
      utterance.onerror = () => {
        if (run !== playbackRunRef.current) return;
        setSpeaking(false);
        restoreSelection();
      };
      speechSynthesis.speak(utterance);
    };
    void playNext(0);
  };
  const beginDrag = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const next = new Set(selectedCutIds);
    if (e.shiftKey) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else if (!next.has(id)) {
      next.clear();
      next.add(id);
    }
    if (!next.has(id)) return;
    setSelectedCutIds(next);
    dragAnchorLine.current = cuts.find((item) => item.id === id)?.line ?? 0;
    dragStartLines.current = new Map(
      cuts
        .filter((item) => next.has(item.id))
        .map((item) => [item.id, item.line]),
    );
    setDragId(id);
  };
  const addSceneDivider = (line: number) =>
    setSceneDividers((current) =>
      current.some((divider) => divider.line === line)
        ? current
        : [
            ...current,
            { id: crypto.randomUUID(), line, color: "#8b8b8b", text: "" },
          ].sort((a, b) => a.line - b.line),
    );
  const beginSceneDrag = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSceneDragId(id);
  };
  const moveSceneDivider = (e: React.PointerEvent) => {
    if (!sceneDragId || !scenePanelRef.current) return;
    const rect = scenePanelRef.current.getBoundingClientRect(),
      maxRow = Math.max(
        sceneDisplayLines - 1,
        Math.floor((rect.height - 42) / (fontSize * 1.55)) - 1,
      ),
      row = Math.max(
        0,
        Math.min(
          maxRow,
          Math.floor((e.clientY - rect.top - 42) / (fontSize * 1.55)),
        ),
      );
    setSceneDividers((current) => {
      if (current.some((divider) => divider.id !== sceneDragId && divider.line === row))
        return current;
      return current
        .map((divider) =>
          divider.id === sceneDragId ? { ...divider, line: row } : divider,
        )
        .sort((a, b) => a.line - b.line);
    });
  };
  const beginResize = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setResizeId(id);
  };
  const startDurationEdit = (cut: Cut, currentFrames: number) => {
    setDurationDraft(
      plus(cut.manual && cut.frames != null ? cut.frames : currentFrames),
    );
    setEditingDurationId(cut.id);
  };
  const commitDuration = (cut: Cut) => {
    const frames = parseDurationFrames(durationDraft);
    if (frames == null || !Number.isSafeInteger(frames)) {
      setEditingDurationId(null);
      return;
    }
    setCuts((value) =>
      value.map((item) =>
        item.id === cut.id ? { ...item, frames, manual: true } : item,
      ),
    );
    setEditingDurationId(null);
  };
  const patternRegex = (pattern: string) => {
    const a = pattern.indexOf("A"),
      b = pattern.indexOf("B");
    if (a < 0 || b <= a) return null;
    const escape = (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `^\\s*${escape(pattern.slice(0, a))}(?<name>.+?)${escape(pattern.slice(a + 1, b))}(?<body>.*?)${escape(pattern.slice(b + 1))}\\s*$`,
    );
  };
  const formatImportedDialogue = (name: string, body: string) => {
    let value = body.trim();
    if (breakEllipsis) value = value.replace(/(・・・|…+)/g, "$1\n");
    if (breakComma) value = value.replace(/([、，,])/g, "$1\n");
    if (breakPeriod) value = value.replace(/([。．.])/g, "$1\n");
    if (breakMarks) value = value.replace(/([！？!?])/g, "$1\n");
    return value
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `[${name.trim()}]${line}`);
  };
  const splitImportedText = (text: string) => {
    const left: string[] = [],
      right: string[] = [];
    for (const raw of text.replace(/\r/g, "").split("\n")) {
      const line = raw.trim();
      let recognized: { name: string; body: string } | null = null;
      for (const pattern of dialoguePatterns) {
        const match = patternRegex(pattern)?.exec(line);
        if (match?.groups?.name && match.groups.body != null) {
          recognized = { name: match.groups.name, body: match.groups.body };
          break;
        }
      }
      const quoted = recognized
        ? []
        : [...line.matchAll(/([^\s「『」』]{1,20})\s*[「『](.*?)[」』]/g)];
      if (recognized) {
        for (const value of formatImportedDialogue(
          recognized.name,
          recognized.body,
        )) {
          left.push("");
          right.push(value);
        }
      } else if (quoted.length) {
        for (const match of quoted) {
          for (const value of formatImportedDialogue(match[1], match[2])) {
            left.push("");
            right.push(value);
          }
        }
      } else {
        left.push(raw);
        right.push("");
      }
    }
    return { left, right };
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    setBusy(`${file.name} を解析中…`);
    try {
      const ext = file.name.toLowerCase().split(".").pop();
      if (ext === "json") {
        const p = JSON.parse(await file.text());
        setAction(p.action ?? "");
        setDialogue(
          (p.dialogue ?? "").replaceAll("［", "[").replaceAll("］", "]"),
        );
        setCps(Number(p.chars_per_sec ?? 8));
        setFontSize(Number(p.font_size ?? 15));
        setMode(Number(p.mode) === 1 ? "seconds" : "frames");
        setFirstCutName(String(p.first_cut_name ?? p.cut_names?.[0] ?? "1"));
        setSceneText(String(p.scene_text ?? ""));
        setSceneDividers(
          Array.isArray(p.scene_dividers)
            ? p.scene_dividers
                .map((divider: Partial<SceneDivider>, index: number) => ({
                  id: divider.id ?? crypto.randomUUID(),
                  line: Math.max(0, Number(divider.line) || 0),
                  color: divider.color ?? "#8b8b8b",
                  text:
                    typeof divider.text === "string"
                      ? divider.text
                      : index === 0
                        ? String(p.scene_text ?? "")
                        : "",
                }))
            : [],
        );
        if (Number.isFinite(Number(p.scene_width)))
          setSceneWidth(Math.max(120, Math.min(520, Number(p.scene_width))));
        setDialoguePatterns(p.dialogue_patterns ?? ["A「B」", "A『B』"]);
        const oldPunctuation = Boolean(p.break_at_punctuation);
        setBreakComma(Boolean(p.break_at_comma ?? oldPunctuation));
        setBreakPeriod(Boolean(p.break_at_period ?? oldPunctuation));
        setBreakMarks(Boolean(p.break_at_exclamation_question));
        setBreakEllipsis(Boolean(p.break_at_ellipsis));
        setSpeakerColors(
          p.speaker_colors && typeof p.speaker_colors === "object"
            ? p.speaker_colors
            : {},
        );
        setSpeakerPitch(
          p.speaker_pitch && typeof p.speaker_pitch === "object"
            ? p.speaker_pitch
            : {},
        );
        setVoicevoxSpeakerStyles(
          p.voicevox_speaker_styles &&
            typeof p.voicevox_speaker_styles === "object"
            ? p.voicevox_speaker_styles
            : {},
        );
        if (typeof p.voicevox_url === "string" && p.voicevox_url.trim())
          setVoicevoxUrl(p.voicevox_url);
        if (p.playback_engine === "browser" || p.playback_engine === "voicevox")
          setPlaybackEngine(p.playback_engine);
        if (Number.isFinite(Number(p.playback_rate)))
          setPlaybackRate(Math.max(0.5, Math.min(2, Number(p.playback_rate))));
        if (typeof p.sync_playback_rate === "boolean")
          setSyncPlaybackRate(p.sync_playback_rate);
        const dialogueText = String(p.dialogue ?? ""),
          rowAt = (position: unknown) =>
            dialogueText
              .slice(0, Math.max(0, Number(position) || 0))
              .split("\n").length - 1;
        setCuts(
          (p.cuts ?? []).map(
            (
              c: Cut & {
                block?: number;
                block_no?: number;
                trim_rows?: number;
                char_pos?: number;
                trim_end_pos?: number;
              },
              i: number,
            ) => ({
              ...c,
              id: c.id ?? crypto.randomUUID(),
              name: c.name ?? p.cut_names?.[i + 1] ?? String(i + 2),
              line: c.line ?? c.block ?? c.block_no ?? rowAt(c.char_pos),
              trimRows:
                c.trimRows ??
                c.trim_rows ??
                Math.max(0, rowAt(c.trim_end_pos) - rowAt(c.char_pos)),
            }),
          ),
        );
        setSelectedCutIds(new Set());
        return;
      }
      let text = "";
      if (ext === "docx") {
        const buffer = await file.arrayBuffer();
        try {
          const module = await import("mammoth/mammoth.browser"),
            mammoth = (module as any).default ?? module;
          text = (await mammoth.extractRawText({ arrayBuffer: buffer })).value;
        } catch {
          text = "";
        }
        if (!text.trim()) {
          const { default: JSZip } = await import("jszip"),
            zip = await JSZip.loadAsync(buffer),
            targets = Object.keys(zip.files).filter(
              (name) =>
                name === "word/document.xml" ||
                name.startsWith("word/header") ||
                name.startsWith("word/footer"),
            ),
            paragraphs: string[] = [];
          for (const name of targets) {
            const xml = await zip.file(name)?.async("string");
            if (!xml) continue;
            const document = new DOMParser().parseFromString(
              xml,
              "application/xml",
            );
            for (const paragraph of Array.from(
              document.getElementsByTagNameNS("*", "p"),
            )) {
              let value = "";
              for (const node of Array.from(
                paragraph.getElementsByTagName("*"),
              )) {
                if (node.localName === "t") value += node.textContent ?? "";
                else if (node.localName === "tab") value += "\t";
                else if (node.localName === "br" || node.localName === "cr")
                  value += "\n";
              }
              if (value.trim()) paragraphs.push(value.trim());
            }
          }
          text = paragraphs.join("\n");
        }
        if (!text.trim())
          throw new Error("Word文書から文字を取得できませんでした。");
      } else if (ext === "pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/pdf.worker.min.mjs`;
        const pdf = await pdfjs.getDocument({
          data: new Uint8Array(await file.arrayBuffer()),
        }).promise;
        const pages: string[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n),
            content = await page.getTextContent(),
            items = (content.items as any[])
              .filter((x) => x.str?.trim())
              .map((x) => ({
                s: String(x.str),
                x: Number(x.transform[4]),
                y: Number(x.transform[5]),
              }));
          const xs = new Set(items.map((x) => Math.round(x.x / 8))),
            ys = new Set(items.map((x) => Math.round(x.y / 8))),
            vertical = xs.size > ys.size * 0.65;
          if (vertical) {
            const groups = new Map<number, typeof items>();
            for (const it of items) {
              const k = Math.round(it.x / 10) * 10;
              groups.set(k, [...(groups.get(k) ?? []), it]);
            }
            pages.push(
              [...groups.entries()]
                .sort((a, b) => b[0] - a[0])
                .map(([, v]) =>
                  v
                    .sort((a, b) => b.y - a.y)
                    .map((x) => x.s)
                    .join(""),
                )
                .join("\n"),
            );
          } else {
            items.sort((a, b) =>
              Math.abs(a.y - b.y) > 4 ? b.y - a.y : a.x - b.x,
            );
            let prev = Infinity,
              row = "";
            const rows: string[] = [];
            for (const it of items) {
              if (Math.abs(prev - it.y) > 4 && row) {
                rows.push(row);
                row = "";
              }
              row += it.s;
              prev = it.y;
            }
            if (row) rows.push(row);
            pages.push(rows.join("\n"));
          }
        }
        text = pages.join("\n");
      } else text = await file.text();
      const { left, right } = splitImportedText(text);
      setAction(left.join("\n"));
      setDialogue(right.join("\n"));
      setSceneText("");
      setSceneDividers([]);
      setFirstCutName("1");
      setCuts([]);
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "読み込みに失敗しました。",
      );
    } finally {
      setBusy("");
    }
  };
  const hasDraggedFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");
  const handleFileDragOver = (e: React.DragEvent) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setFileDragActive(true);
  };
  const handleFileDrop = (e: React.DragEvent) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    setFileDragActive(false);
    void importFile(e.dataTransfer.files[0]);
  };
  const project = () =>
    JSON.stringify(
      {
        version: 48,
        chars_per_sec: cps,
        mode: mode === "frames" ? 0 : 1,
        font_size: fontSize,
        action,
        dialogue,
        scene_text: sceneText,
        scene_dividers: sceneDividers,
        scene_width: sceneWidth,
        first_cut_name: firstCutName,
        cuts: sortedCuts,
        cut_names: sections.map((s) => s.name),
        speaker_colors: speakerColors,
        speaker_pitch: speakerPitch,
        voicevox_speaker_styles: voicevoxSpeakerStyles,
        voicevox_url: voicevoxUrl,
        playback_engine: playbackEngine,
        playback_rate: playbackRate,
        sync_playback_rate: syncPlaybackRate,
      },
      null,
      2,
    );
  const srt = () => {
    let cursor = 0,
      index = 1,
      out = "";
    const tc = (f: number) => {
      const ms = Math.round((f * 1000) / FPS);
      return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
    };
    for (const s of sections) {
      const body = dialogueLines
        .slice(s.start, s.end)
        .map((x) => x.replace(/^\s*[［\[][^\]］]+[\]］]/, "").trim())
        .filter(Boolean)
        .join("\n");
      if (body)
        out += `${index++}\n${tc(cursor)} --> ${tc(cursor + Math.max(1, s.frames))}\n${body}\n\n`;
      cursor += s.frames;
    }
    return out;
  };
  const voicevox = () =>
    [
      "名前,セリフ",
      ...dialogueLines
        .map(parseDialogue)
        .filter(Boolean)
        .map(
          (m) =>
            `"${m!.speaker.replaceAll('"', '""')}","${m!.body.replaceAll('"', '""')}"`,
        ),
    ].join("\r\n");
  const speakerBoardWidth = (ctx: CanvasRenderingContext2D, speaker: string) => {
    ctx.font = 'bold 52px "Yu Gothic UI",sans-serif';
    return Math.ceil(ctx.measureText(speaker).width) + 64;
  };
  const drawSpeakerBoard = (
    ctx: CanvasRenderingContext2D,
    speaker: string,
    color: string,
    x: number,
    y: number,
  ) => {
    const width = speakerBoardWidth(ctx, speaker);
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x + 2, y + 2, width - 4, 92, 12);
    ctx.fill();
    ctx.font = 'bold 52px "Yu Gothic UI",sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#000";
    ctx.strokeText(speaker, x + width / 2, y + 48);
    ctx.fillStyle = "#fff";
    ctx.fillText(speaker, x + width / 2, y + 48);
    ctx.restore();
    return width;
  };
  const boardPng = async (speaker: string, color: string) => {
    const c = document.createElement("canvas"),
      ctx = c.getContext("2d")!;
    const w = speakerBoardWidth(ctx, speaker);
    c.width = w;
    c.height = 96;
    drawSpeakerBoard(ctx, speaker, color, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      c.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG作成失敗"))),
        "image/png",
      ),
    );
  };
  const exportXdts = async () => {
    setBusy("XDTS＋セリフボールドを作成中…");
    try {
      const zip = new JSZip(),
        root = zip.folder("storyboard_export")!,
        speakerList: string[] = [];
      dialogueLines.forEach((l) => {
        const p = parseDialogue(l);
        if (p && !speakerList.includes(p.speaker)) speakerList.push(p.speaker);
      });
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i],
          dir = root.folder(`C${String(i + 1).padStart(3, "0")}`)!,
          sectionLines = dialogueLines.slice(s.start, s.end),
          dialogFrames: object[] = [];
        let cursor = 0;
        for (let row = 0; row < sectionLines.length; row++) {
          const item = parseDialogue(sectionLines[row]);
          if (item?.body) {
            const len = Math.max(
              1,
              readingFrames(`[${item.speaker}]${item.body}`, cps),
            );
            dialogFrames.push({
              frame: cursor,
              data: [{ id: 0, values: [item.speaker, item.body] }],
            });
            for (let f = cursor + 1; f < cursor + len; f++)
              dialogFrames.push({
                frame: f,
                data: [{ id: 0, values: ["SYMBOL_HYPHEN"] }],
              });
            cursor += len;
            const ci = speakerList.indexOf(item.speaker) % colors.length;
            dir.file(
              `[${safe(item.speaker)}]${safe(item.body)}.png`,
              await boardPng(item.speaker, colors[ci]),
            );
          }
          if (row < sectionLines.length - 1) cursor += 6;
        }
        const fields: any[] = [
            { fieldId: 0, tracks: [{ trackNo: 0, frames: [] }] },
          ],
          headers: any[] = [{ fieldId: 0, names: ["S1"] }];
        if (dialogFrames.length) {
          fields.push({
            fieldId: 3,
            tracks: [{ trackNo: 0, frames: dialogFrames }],
          });
          headers.push({ fieldId: 3, names: ["Dialog"] });
        }
        const name = `storyboard_export_${String(i + 1).padStart(3, "0")}`,
          xdts = {
            header: { cut: name, scene: "1" },
            timeTables: [
              {
                duration: Math.max(1, s.frames, cursor),
                name,
                timeTableHeaders: headers,
                fields,
              },
            ],
            version: 5,
          };
        dir.file(
          `${name}.xdts`,
          "exchangeDigitalTimeSheet Save Data\n" + JSON.stringify(xdts),
        );
      }
      root.file(
        "cast_colors.csv",
        "\ufeff名前,座布団色\r\n" +
          speakerList
            .map((s, i) => `"${s}",${colors[i % colors.length]}`)
            .join("\r\n"),
      );
      download(
        "storyboard_export.zip",
        await zip.generateAsync({ type: "blob" }),
        "application/zip",
      );
    } finally {
      setBusy("");
    }
  };
  const exportXdtsNamed = async () => {
    setBusy("XDTS＋セリフボールドを作成中…");
    try {
      const base = safe(exportName),
        zip = new JSZip(),
        root = zip.folder(base)!;
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i],
          cutCode = xdtsCut(s.name),
          dir = root.folder(`C${cutCode}`)!,
          sectionLines = dialogueLines.slice(s.start, s.end),
          dialogFrames: object[] = [];
        let cursor = 0;
        for (let row = 0; row < sectionLines.length; row++) {
          const item = parseDialogue(sectionLines[row]);
          if (item?.body) {
            const len = Math.max(
              1,
              readingFrames(`[${item.speaker}]${item.body}`, cps),
            );
            dialogFrames.push({
              frame: cursor,
              data: [{ id: 0, values: [item.speaker, item.body] }],
            });
            for (let f = cursor + 1; f < cursor + len; f++)
              dialogFrames.push({
                frame: f,
                data: [{ id: 0, values: ["SYMBOL_HYPHEN"] }],
              });
            cursor += len;
            dir.file(
              `[${safe(item.speaker)}]${safe(item.body)}.png`,
              await boardPng(
                item.speaker,
                speakerColors[item.speaker] ??
                  colors[speakers.indexOf(item.speaker) % colors.length],
              ),
            );
          }
          if (row < sectionLines.length - 1) cursor += 6;
        }
        const fields: any[] = [
            { fieldId: 0, tracks: [{ trackNo: 0, frames: [] }] },
          ],
          headers: any[] = [{ fieldId: 0, names: ["S1"] }];
        if (dialogFrames.length) {
          fields.push({
            fieldId: 3,
            tracks: [{ trackNo: 0, frames: dialogFrames }],
          });
          headers.push({ fieldId: 3, names: ["Dialog"] });
        }
        const name = `${base}_${cutCode}`,
          xdts = {
            header: { cut: name, scene: "1" },
            timeTables: [
              {
                duration: Math.max(1, s.frames, cursor),
                name,
                timeTableHeaders: headers,
                fields,
              },
            ],
            version: 5,
          };
        dir.file(
          `${name}.xdts`,
          "exchangeDigitalTimeSheet Save Data\n" + JSON.stringify(xdts),
        );
      }
      root.file(
        "cast_colors.csv",
        "\ufeff名前,座布団色\r\n" +
          speakers
            .map(
              (s, i) =>
                `"${s}",${speakerColors[s] ?? colors[i % colors.length]}`,
            )
            .join("\r\n"),
      );
      download(
        `${base}.zip`,
        await zip.generateAsync({ type: "blob" }),
        "application/zip",
      );
    } finally {
      setBusy("");
    }
  };
  const exportStoryboard = async () => {
    setBusy("コンテ画像を作成中…");
    try {
      const base = safe(exportName),
        zip = new JSZip(),
        square = 420,
        margin = 90,
        header = 80,
        pageW = margin * 2 + square * (includeAction ? 2 : 1),
        pageH = header + square * gridCount + 50;
      let pageNo = 1,
        used = 0,
        canvas = document.createElement("canvas"),
        ctx = canvas.getContext("2d")!;
      const startPage = () => {
        canvas = document.createElement("canvas");
        canvas.width = pageW;
        canvas.height = pageH;
        ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, pageW, pageH);
        ctx.fillStyle = "#111";
        ctx.font = 'bold 26px "Yu Gothic UI"';
        ctx.fillText(`${base}  ${String(pageNo).padStart(2, "0")}`, margin, 48);
        ctx.strokeStyle = "#777";
        for (let n = 0; n < gridCount; n++) {
          if (includeAction)
            ctx.strokeRect(margin, header + n * square, square, square);
          ctx.strokeRect(
            margin + (includeAction ? square : 0),
            header + n * square,
            square,
            square,
          );
        }
        used = 0;
      };
      startPage();
      for (const s of sections) {
        const blocks = Math.max(1, Math.ceil(Math.max(1, s.frames) / 72));
        if (used + blocks > gridCount) {
          zip.file(
            `${base}_${String(pageNo++).padStart(2, "0")}.png`,
            await new Promise<Blob>((r) =>
              canvas.toBlob((b) => r(b!), "image/png"),
            ),
          );
          startPage();
        }
        const top = header + used * square,
          h = Math.min(blocks, gridCount - used) * square,
          dx = margin + (includeAction ? square : 0);
        ctx.fillStyle = "#111";
        ctx.font = 'bold 24px "Yu Gothic UI"';
        ctx.fillText(s.name, 12, top + 32);
        ctx.font = '18px "Yu Gothic UI"';
        ctx.fillText(plus(s.frames), dx + square + 12, top + h - 10);
        if (includeAction)
          drawBoxText(
            ctx,
            actionLines.slice(s.start, s.end).filter(Boolean).join("\n"),
            margin + 18,
            top + 18,
            square - 36,
            h - 36,
            20,
            "#444",
          );
        let previousSpeaker = "";
        const dtext = dialogueLines
          .slice(s.start, s.end)
          .map(parseDialogue)
          .filter(Boolean)
          .map((p) => {
            const name =
              p!.speaker === previousSpeaker ? "" : `[${p!.speaker}]\n`;
            previousSpeaker = p!.speaker;
            return `${name}${p!.body}`;
          })
          .join("\n");
        drawBoxText(
          ctx,
          dtext,
          dx + 18,
          top + 18,
          square - 36,
          h - 36,
          30,
          "#111",
        );
        used += blocks;
      }
      zip.file(
        `${base}_${String(pageNo).padStart(2, "0")}.png`,
        await new Promise<Blob>((r) =>
          canvas.toBlob((b) => r(b!), "image/png"),
        ),
      );
      download(
        `${base}_storyboard.zip`,
        await zip.generateAsync({ type: "blob" }),
        "application/zip",
      );
    } finally {
      setBusy("");
    }
  };
  const exportPdf = async () => {
    setBusy("縦書きPDFを作成中…");
    try {
      const pdf = new jsPDF({
          orientation: "landscape",
          unit: "mm",
          format: "a4",
        }),
        perPage = 4;
      for (let page = 0; page < Math.ceil(sections.length / perPage); page++) {
        if (page) pdf.addPage("a4", "landscape");
        const c = document.createElement("canvas");
        c.width = 1684;
        c.height = 1190;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = "#222";
        ctx.font = 'bold 28px "Yu Gothic UI",sans-serif';
        ctx.fillText("Storyboard Script Organizer　縦書き台本", 55, 55);
        ctx.font = '18px "Yu Gothic UI",sans-serif';
        ctx.textAlign = "right";
        ctx.fillText(
          `${page + 1} / ${Math.ceil(sections.length / perPage)}`,
          1625,
          55,
        );
        ctx.textAlign = "left";
        const y0 = 90,
          colW = 390,
          pad = 18;
        for (let slot = 0; slot < perPage; slot++) {
          const idx = page * perPage + slot;
          if (idx >= sections.length) break;
          const s = sections[idx],
            x = 55 + (perPage - 1 - slot) * colW;
          ctx.strokeStyle = "#777";
          ctx.strokeRect(x, y0, colW, 1040);
          ctx.fillStyle = "#173f52";
          ctx.fillRect(x, y0, colW, 72);
          ctx.fillStyle = "#fff";
          ctx.font = 'bold 28px "Yu Gothic UI",sans-serif';
          ctx.textBaseline = "alphabetic";
          ctx.textAlign = "left";
          ctx.fillText(`CUT ${s.name}`, x + pad, y0 + 32);
          ctx.font = '19px "Yu Gothic UI",sans-serif';
          ctx.fillText(plus(s.frames), x + pad, y0 + 59);
          ctx.fillStyle = "#f2f0eb";
          ctx.fillRect(x, y0 + 72, colW, 380);
          ctx.fillStyle = "#222";
          ctx.font = 'bold 18px "Yu Gothic UI",sans-serif';
          ctx.fillText("ト書き", x + pad, y0 + 102);
          drawVertical(
            ctx,
            actionLines.slice(s.start, s.end).filter(Boolean).join("\n"),
            x + pad,
            y0 + 116,
            colW - pad * 2,
            318,
            20,
            "#222",
          );
          ctx.fillStyle = "#fffaf6";
          ctx.fillRect(x, y0 + 452, colW, 588);
          ctx.fillStyle = "#873b2b";
          ctx.font = 'bold 18px "Yu Gothic UI",sans-serif';
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
          ctx.fillText("セリフ", x + pad, y0 + 484);
          const dialogueText = dialogueLines
            .slice(s.start, s.end)
            .map(parseDialogue)
            .filter(Boolean)
            .map((p) => `${p!.speaker}　${p!.body}`)
            .join("\n");
          drawVertical(
            ctx,
            dialogueText,
            x + pad,
            y0 + 500,
            colW - pad * 2,
            522,
            21,
            "#873b2b",
          );
        }
        pdf.addImage(c.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 297, 210);
      }
      pdf.save(`${safe(exportName)}.pdf`);
    } finally {
      setBusy("");
    }
  };
  const encodePcmWav = (samples: Float32Array, sampleRate: number) => {
    const buffer = new ArrayBuffer(44 + samples.length * 2),
      view = new DataView(buffer),
      write = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++)
          view.setUint8(offset + i, value.charCodeAt(i));
      };
    write(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
    }
    return buffer;
  };
  const renderVoicevoxPcmSections = async () => {
    if (!voicevoxStyles.length)
      throw new Error(
        "再生設定でVOICEVOXへ接続し、話者スタイルを設定してください。",
      );
    type SpeechItem = { speaker: string; body: string };
    type AudioChunk =
      | { audio: AudioBuffer; body: string; speaker: string }
      | { pauseSeconds: number };
    const isTrimmed = (row: number) =>
        sortedCuts.some(
          (cut) => row >= cut.line && row < cut.line + (cut.trimRows ?? 0),
        ),
      lines = dialogue.split("\n"),
      sectionItems: { section: Section; items: (SpeechItem | { pauseFrames: number })[] }[] = [];
    let activeSpeaker = "";
    for (const section of sections) {
      const rows = Array.from(
          { length: Math.max(0, section.end - section.start) },
          (_, offset) => section.start + offset,
        ).filter((row) => !isTrimmed(row)),
        items: (SpeechItem | { pauseFrames: number })[] = [];
      rows.forEach((row, index) => {
        const parsed = parseDialogue(lines[row] ?? "");
        if (parsed) {
          activeSpeaker = parsed.speaker;
          if (parsed.body)
            items.push({ speaker: parsed.speaker, body: parsed.body });
        } else if (lines[row]?.trim()) {
          items.push({ speaker: activeSpeaker, body: lines[row].trim() });
        }
        // readingFrames adds six frames for every newline, not only blank rows.
        if (index < rows.length - 1) items.push({ pauseFrames: 6 });
      });
      sectionItems.push({ section, items });
    }
    const speechCount = sectionItems.reduce(
      (sum, entry) => sum + entry.items.filter((item) => "body" in item).length,
      0,
    );
    if (!speechCount) throw new Error("書き出すセリフがありません。");
    const audioContext = new AudioContext(),
      baseSpeed = Math.max(
        0.5,
        Math.min(2, playbackRate * (syncPlaybackRate ? cps / 8 : 1)),
      ),
      renderedSections: { frames: number; chunks: AudioChunk[] }[] = [];
    let completed = 0;
    try {
      const base = voicevoxUrl.trim().replace(/\/+$/, ""),
        synthesize = async (item: SpeechItem, speedScale: number) => {
        const styleId =
          voicevoxSpeakerStyles[item.speaker] ?? voicevoxStyles[0]?.id;
        if (styleId == null) throw new Error(`[${item.speaker}]の話者設定がありません。`);
        const queryResponse = await fetch(
          `${base}/audio_query?text=${encodeURIComponent(item.body)}&speaker=${styleId}`,
          { method: "POST" },
        );
        if (!queryResponse.ok)
          throw new Error(`音声クエリ HTTP ${queryResponse.status}`);
        const query = (await queryResponse.json()) as Record<string, unknown>;
        query.speedScale = Math.max(0.5, Math.min(2, speedScale));
        const audioResponse = await fetch(`${base}/synthesis?speaker=${styleId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(query),
        });
        if (!audioResponse.ok)
          throw new Error(`音声合成 HTTP ${audioResponse.status}`);
        return audioContext.decodeAudioData(await audioResponse.arrayBuffer());
      };
      for (let sectionIndex = 0; sectionIndex < sectionItems.length; sectionIndex++) {
        const entry = sectionItems[sectionIndex],
          renderAtSpeed = async (speed: number, retry: boolean) => {
            const chunks: AudioChunk[] = [];
            for (const item of entry.items) {
              if ("pauseFrames" in item) {
                chunks.push({ pauseSeconds: item.pauseFrames / FPS });
              } else {
                setBusy(
                  `VOICEVOX音声を${retry ? "尺に合わせて再" : ""}生成中… ${Math.min(completed + 1, speechCount)} / ${speechCount}`,
                );
                chunks.push({
                  audio: await synthesize(item, speed),
                  body: item.body,
                  speaker: item.speaker,
                });
                if (!retry) completed++;
              }
            }
            return chunks;
          };
        let chunks = await renderAtSpeed(baseSpeed, false);
        const pauseDuration = chunks.reduce(
            (sum, chunk) => sum + ("pauseSeconds" in chunk ? chunk.pauseSeconds : 0),
            0,
          ),
          speechDuration = chunks.reduce(
            (sum, chunk) => sum + ("audio" in chunk ? chunk.audio.duration : 0),
            0,
          ),
          targetDuration = entry.section.frames / FPS,
          availableSpeechDuration = Math.max(0.01, targetDuration - pauseDuration);
        if (speechDuration > availableSpeechDuration * 1.01) {
          const adjustedSpeed = Math.min(
            2,
            baseSpeed * (speechDuration / availableSpeechDuration) * 1.01,
          );
          if (adjustedSpeed > baseSpeed + 0.01)
            chunks = await renderAtSpeed(adjustedSpeed, true);
        }
        renderedSections.push({ frames: entry.section.frames, chunks });
      }
      const sampleRate =
          renderedSections
            .flatMap((entry) => entry.chunks)
            .find(
              (chunk): chunk is { audio: AudioBuffer; body: string; speaker: string } =>
                "audio" in chunk,
            )
            ?.audio.sampleRate ?? 24000,
        totalSamples = Math.round((total / FPS) * sampleRate),
        sectionLengths = renderedSections.map((entry) =>
          Math.round((entry.frames / FPS) * sampleRate),
        ),
        previousSamples = sectionLengths
          .slice(0, -1)
          .reduce((sum, value) => sum + value, 0);
      if (sectionLengths.length)
        sectionLengths[sectionLengths.length - 1] = Math.max(
          0,
          totalSamples - previousSamples,
        );
      const subtitleSections: {
          startFrame: number;
          endFrame: number;
          body: string;
          speaker: string;
        }[][] = [],
        pcmSections = renderedSections.map(
        (entry, sectionIndex) => {
          const output = new Float32Array(sectionLengths[sectionIndex]);
          const cues: {
            startFrame: number;
            endFrame: number;
            body: string;
            speaker: string;
          }[] = [];
          let position = 0;
          const sectionEnd = output.length;
        for (const chunk of entry.chunks) {
          if (position >= sectionEnd) break;
          if ("pauseSeconds" in chunk) {
            position = Math.min(
              sectionEnd,
              position + Math.round(chunk.pauseSeconds * sampleRate),
            );
            continue;
          }
          const channels = Array.from(
              { length: chunk.audio.numberOfChannels },
              (_, channel) => chunk.audio.getChannelData(channel),
            ),
            length = Math.min(
              sectionEnd - position,
              Math.round(chunk.audio.duration * sampleRate),
            );
          const startFrame = Math.floor((position / sampleRate) * FPS),
            endFrame = Math.max(
              startFrame + 1,
              Math.ceil(((position + length) / sampleRate) * FPS),
            );
          cues.push({
            startFrame,
            endFrame,
            body: chunk.body,
            speaker: chunk.speaker,
          });
          for (let i = 0; i < length; i++) {
            const sourceIndex = Math.min(
                channels[0].length - 1,
                Math.floor((i / sampleRate) * chunk.audio.sampleRate),
              ),
              value = channels.reduce(
                (sum, channel) => sum + channel[sourceIndex],
                0,
              );
              output[position + i] = value / channels.length;
          }
          position += length;
        }
        // Pad a short cut with silence, or finish after truncating a cut that
        // is still too long even at VOICEVOX's maximum speed.
        position = sectionEnd;
          subtitleSections.push(cues);
          return output;
        },
      );
      setBusy("WAVファイルを作成中…");
      return { sampleRate, pcmSections, subtitleSections };
    } finally {
      await audioContext.close();
      setBusy("");
    }
  };
  const exportVoicevoxWav = async (name: string) => {
    const { sampleRate, pcmSections, subtitleSections } = await renderVoicevoxPcmSections(),
      output = new Float32Array(
        pcmSections.reduce((sum, samples) => sum + samples.length, 0),
      );
    let position = 0;
    for (const samples of pcmSections) {
      output.set(samples, position);
      position += samples.length;
    }
    download(`${name}.wav`, encodePcmWav(output, sampleRate), "audio/wav");
  };
  const movieTimecode = (frames: number) => {
    const minutes = Math.floor(frames / (FPS * 60)),
      seconds = Math.floor(frames / FPS) % 60,
      rest = frames % FPS;
    return [minutes, seconds, rest]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  };
  const drawMovieFrame = (
    ctx: CanvasRenderingContext2D,
    cutNumber: string,
    frameNumber: number,
    boldSpeaker = "",
  ) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ef3f35";
    ctx.font = '700 64px "Yu Gothic UI", sans-serif';
    ctx.fillText(cutNumber, 160, 80, 240);
    ctx.textAlign = "right";
    ctx.fillStyle = "#fff";
    ctx.font = '600 54px "Consolas", "Courier New", monospace';
    ctx.fillText(movieTimecode(frameNumber), 1880, 1020);
    if (!boldSpeaker) return;
    const speakerIndex = Math.max(0, speakers.indexOf(boldSpeaker)),
      color = speakerColors[boldSpeaker] ?? colors[speakerIndex % colors.length];
    drawSpeakerBoard(ctx, boldSpeaker, color, 520, 800);
  };
  const exportMovieZipWithFfmpeg = async (name: string) => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg"),
      ffmpeg = new FFmpeg(),
      basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "",
      { sampleRate, pcmSections, subtitleSections } = await renderVoicevoxPcmSections(),
      zip = new JSZip(),
      canvas = document.createElement("canvas");
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("映像用Canvasを作成できませんでした。");
    let activeCut = 0;
    ffmpeg.on("progress", ({ progress }) => {
      setBusy(
        `MP4を生成中… ${activeCut + 1} / ${sections.length}（${Math.max(0, Math.min(100, Math.round(progress * 100)))}%）`,
      );
    });
    setBusy("MP4エンジンを読み込んでいます…");
    try {
      const loadController = new AbortController();
      const loadTimeout = window.setTimeout(() => loadController.abort(), 60_000);
      try {
        await ffmpeg.load(
          {
            classWorkerURL: `${window.location.origin}${basePath}/ffmpeg/ffmpeg-worker.js`,
            coreURL: `${window.location.origin}${basePath}/ffmpeg/ffmpeg-core.js`,
            wasmURL: `${window.location.origin}${basePath}/ffmpeg/ffmpeg-core.wasm`,
          },
          { signal: loadController.signal },
        );
      } catch (error) {
        if (loadController.signal.aborted) {
          throw new Error("MP4エンジンの読み込みがタイムアウトしました。ページを再読み込みして、もう一度お試しください。");
        }
        const detail =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : String(error);
        throw new Error(`MP4エンジンを読み込めませんでした。${detail}`);
      } finally {
        window.clearTimeout(loadTimeout);
      }
      for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
        activeCut = sectionIndex;
        const section = sections[sectionIndex],
          cutNumber = xdtsCut(section.name),
          framePrefix = `cut_${sectionIndex}_frame_`,
          wavName = `cut_${sectionIndex}.wav`,
          mp4Name = `cut_${sectionIndex}.mp4`;
        const frameNames: string[] = [];
        for (let frameIndex = 0; frameIndex < section.frames; frameIndex++) {
          const cue = movieDialogueBold
              ? subtitleSections[sectionIndex]?.find(
                  (item) => frameIndex >= item.startFrame && frameIndex < item.endFrame,
                )
              : undefined,
            frameName = `${framePrefix}${String(frameIndex).padStart(6, "0")}.png`;
          drawMovieFrame(ctx, cutNumber, frameIndex + 1, cue?.speaker);
          const png = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (blob) => (blob ? resolve(blob) : reject(new Error("画像生成に失敗しました。"))),
              "image/png",
            ),
          );
          await ffmpeg.writeFile(frameName, new Uint8Array(await png.arrayBuffer()));
          frameNames.push(frameName);
        }
        await ffmpeg.writeFile(
          wavName,
          new Uint8Array(
            encodePcmWav(pcmSections[sectionIndex] ?? new Float32Array(), sampleRate),
          ),
        );
        const duration = (section.frames / FPS).toFixed(6),
          exitCode = await ffmpeg.exec([
            "-framerate",
            String(FPS),
            "-i",
            `${framePrefix}%06d.png`,
            "-i",
            wavName,
            "-t",
            duration,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "stillimage",
            "-pix_fmt",
            "yuv420p",
            "-r",
            String(FPS),
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-shortest",
            mp4Name,
          ]);
        if (exitCode !== 0)
          throw new Error(`CUT ${cutNumber} のMP4生成に失敗しました。`);
        const movie = await ffmpeg.readFile(mp4Name);
        if (typeof movie === "string") throw new Error("MP4データを取得できませんでした。");
        zip.file(`${cutNumber}.mp4`, movie);
        await Promise.all([
          ...frameNames.map((frameName) => ffmpeg.deleteFile(frameName)),
          ffmpeg.deleteFile(wavName),
          ffmpeg.deleteFile(mp4Name),
        ]);
      }
      setBusy("MP4をZIPにまとめています…");
      const body = await zip.generateAsync({ type: "blob" });
      download(`${name}_mp4.zip`, body, "application/zip");
    } finally {
      ffmpeg.terminate();
      setBusy("");
    }
  };
  const exportMovieZip = async (name: string) => {
    if (
      typeof VideoEncoder === "undefined" ||
      typeof AudioEncoder === "undefined" ||
      typeof VideoFrame === "undefined" ||
      typeof AudioData === "undefined"
    )
      return exportMovieZipWithFfmpeg(name);
    const videoCandidates = ["avc1.640028", "avc1.4d4028", "avc1.420028"],
      videoConfig = (
        await Promise.all(
          videoCandidates.map((codec) =>
            VideoEncoder.isConfigSupported({
              codec,
              width: 1920,
              height: 1080,
              bitrate: 6_000_000,
              framerate: FPS,
              avc: { format: "avc" },
            }),
          ),
        )
      ).find((result) => result.supported)?.config;
    if (!videoConfig)
      throw new Error("この端末ではH.264エンコーダーを利用できません。");
    const audioSampleRate = 48000,
      audioConfig: AudioEncoderConfig = {
        codec: "mp4a.40.2",
        sampleRate: audioSampleRate,
        numberOfChannels: 1,
        bitrate: 128000,
      },
      audioSupport = await AudioEncoder.isConfigSupported(audioConfig);
    if (!audioSupport.supported)
      throw new Error("この端末ではAACエンコーダーを利用できません。");
    const { sampleRate, pcmSections, subtitleSections } = await renderVoicevoxPcmSections(),
      zip = new JSZip(),
      canvas = document.createElement("canvas");
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("映像用Canvasを作成できませんでした。");
    const resample = (source: Float32Array) => {
        if (sampleRate === audioSampleRate) return source;
        const result = new Float32Array(
          Math.round((source.length / sampleRate) * audioSampleRate),
        );
        for (let i = 0; i < result.length; i++) {
          const sourcePosition = (i * sampleRate) / audioSampleRate,
            before = Math.min(source.length - 1, Math.floor(sourcePosition)),
            after = Math.min(source.length - 1, before + 1),
            ratio = sourcePosition - before;
          result[i] = source[before] * (1 - ratio) + source[after] * ratio;
        }
        return result;
      };
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      for (let attempt = 0; attempt < 2; attempt++) {
      const failure: { error: Error | null } = { error: null };
      const section = sections[sectionIndex],
        cutNumber = xdtsCut(section.name),
        target = new ArrayBufferTarget(),
        muxer = new Muxer({
          target,
          video: {
            codec: "avc",
            width: 1920,
            height: 1080,
            frameRate: FPS,
          },
          audio: {
            codec: "aac",
            numberOfChannels: 1,
            sampleRate: audioSampleRate,
          },
          fastStart: "in-memory",
        }),
        videoEncoder = new VideoEncoder({
          output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
          error: (error) => { failure.error = error; },
        }),
        audioEncoder = new AudioEncoder({
          output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
          error: (error) => { failure.error = error; },
        });
      try {
      videoEncoder.configure({ ...videoConfig, hardwareAcceleration: "prefer-software" });
      audioEncoder.configure(audioSupport.config ?? audioConfig);
      const drainQueue = async (encoder: VideoEncoder | AudioEncoder, limit: number) => {
        const started = performance.now();
        while (encoder.encodeQueueSize > limit) {
          if (failure.error) throw failure.error;
          if (encoder.state === "closed") throw new Error("映像・音声エンコーダーが停止しました。");
          if (performance.now() - started > 120_000) throw new Error("エンコード処理が応答しません。");
          await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
        }
        if (failure.error) throw failure.error;
      };
      for (let frameIndex = 0; frameIndex < section.frames; frameIndex++) {
        setBusy(
          `MP4映像を生成中… CUT ${cutNumber}（${sectionIndex + 1} / ${sections.length}）`,
        );
        const cue = movieDialogueBold
          ? subtitleSections[sectionIndex]?.find(
              (item) => frameIndex >= item.startFrame && frameIndex < item.endFrame,
            )
          : undefined;
        drawMovieFrame(ctx, cutNumber, frameIndex + 1, cue?.speaker);
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((frameIndex / FPS) * 1_000_000),
          duration: Math.round(1_000_000 / FPS),
        });
        try { videoEncoder.encode(frame, {
          keyFrame: frameIndex === 0 || frameIndex % (FPS * 2) === 0,
        }); } finally { frame.close(); }
        await drainQueue(videoEncoder, 4);
      }
      await videoEncoder.flush();
      if (failure.error) throw failure.error;
      videoEncoder.close();
      const audio = resample(pcmSections[sectionIndex] ?? new Float32Array()),
        audioBlock = 1024;
      for (let offset = 0; offset < audio.length; offset += audioBlock) {
        const length = Math.min(audioBlock, audio.length - offset),
          data = audio.slice(offset, offset + length),
          audioData = new AudioData({
            format: "f32-planar",
            sampleRate: audioSampleRate,
            numberOfFrames: length,
            numberOfChannels: 1,
            timestamp: Math.round((offset / audioSampleRate) * 1_000_000),
            data,
          });
        try { audioEncoder.encode(audioData); } finally { audioData.close(); }
        await drainQueue(audioEncoder, 8);
      }
      await audioEncoder.flush();
      if (failure.error) throw failure.error;
      audioEncoder.close();
      muxer.finalize();
      zip.file(`${cutNumber}.mp4`, target.buffer);
      pcmSections[sectionIndex] = new Float32Array();
      break;
      } catch (error) {
        if (attempt === 1) {
          throw new Error(`CUT ${cutNumber}（${sectionIndex + 1}/${sections.length}、${section.frames}コマ）のMP4生成に失敗しました。${failure.error?.message ?? (error instanceof Error ? error.message : String(error))}`);
        }
        setBusy(`CUT ${cutNumber} を再生成しています…`);
      } finally {
        if (videoEncoder.state !== "closed") videoEncoder.close();
        if (audioEncoder.state !== "closed") audioEncoder.close();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      }
      }
    }
    setBusy("MP4をZIPにまとめています…");
    const body = await zip.generateAsync({ type: "blob" });
    download(`${name}_mp4.zip`, body, "application/zip");
    setBusy("");
  };
  const openExport = (kind: ExportKind) => {
    setMenu(false);
    setExportKind(kind);
    setExportName(
      kind === "project"
        ? "storyboard_project"
        : kind === "xdts"
          ? "xdts_export"
          : kind === "storyboard"
            ? "storyboard"
            : "script",
    );
    if (kind === "xdts")
      setSpeakerColors(
        Object.fromEntries(
          speakers.map((s, i) => [
            s,
            speakerColors[s] ?? colors[i % colors.length],
          ]),
        ),
      );
  };
  const runExport = async () => {
    const name = safe(exportName);
    setExportKind(null);
    if (exportKind === "project")
      await saveToChosenLocation(
        `${name}.ssp.json`,
        project(),
        "application/json",
      );
    else if (exportKind === "pdf") await exportPdf();
    else if (exportKind === "xdts") await exportXdtsNamed();
    else if (exportKind === "storyboard") await exportStoryboard();
    else if (exportKind === "srt") download(`${name}.srt`, srt());
    else if (exportKind === "voicevox")
      download(`${name}.csv`, "\ufeff" + voicevox(), "text/csv;charset=utf-8");
    else if (exportKind === "wav") {
      try {
        await exportVoicevoxWav(name);
      } catch (error) {
        setBusy("");
        window.alert(
          error instanceof Error ? error.message : "WAV書き出しに失敗しました。",
        );
      }
    } else if (exportKind === "movie") {
      try {
        await exportMovieZip(name);
      } catch (error) {
        setBusy("");
        const detail =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : error instanceof Event
                ? `${error.type}（ブラウザ内のMP4エンジンでエラーが発生しました）`
                : String(error);
        window.alert(detail || "MP4書き出しに失敗しました。");
      }
    }
  };

  return (
    <main
      className="app-shell"
      style={
        {
          "--left-col": `${split}fr`,
          "--right-col": `${100 - split}fr`,
        } as React.CSSProperties
      }
      onPointerMove={(e) => {
        dragMove(e);
        moveSceneDivider(e);
        resizeSceneColumn(e);
        resizeColumns(e);
      }}
      onPointerUp={() => {
        setDragId(null);
        setResizeId(null);
        setSceneDragId(null);
        setSceneWidthDragging(false);
        setSplitDragging(false);
      }}
      onKeyDownCapture={handleHistoryKeyDown}
      onDragEnter={(e) => {
        if (hasDraggedFiles(e)) {
          e.preventDefault();
          setFileDragActive(true);
        }
      }}
      onDragOver={handleFileDragOver}
      onDragLeave={(e) => {
        if (
          hasDraggedFiles(e) &&
          !e.currentTarget.contains(e.relatedTarget as Node | null)
        )
          setFileDragActive(false);
      }}
      onDrop={handleFileDrop}
    >
      {fileDragActive && (
        <div className="file-drop-overlay" aria-hidden="true">
          <div>
            <strong>ファイルをここにドロップ</strong>
            <span>TXT・Word・PDF・SSP JSON</span>
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="mark">SC</span>
          <div>
            <b>Storyboard Script Organizer</b>
            <small>WEB EDITION · v0.48 LIGHT BASE</small>
          </div>
        </div>
        <nav>
          <button
            title="TXT・Word・PDF・SSP JSONを読み込む（ドラッグ＆ドロップ対応）"
            onClick={() => fileRef.current?.click()}
          >
            読み込む
          </button>
          <button onClick={() => setImportSettingsOpen(true)}>
            読み込み設定
          </button>
          <button className="primary" onClick={() => setMenu(!menu)}>
            保存・書き出し
          </button>
          {menu && (
            <div className="export-menu">
              <b>保存・書き出し</b>
              <button onClick={() => openExport("project")}>
                作業データ（SSP JSON）
              </button>
              <button onClick={() => openExport("pdf")}>
                台本（縦書きPDF）
              </button>
              <button onClick={() => openExport("xdts")}>
                XDTS＋セリフボールド（ZIP）
              </button>
              <button onClick={() => openExport("storyboard")}>
                コンテ用画像（ZIP）
              </button>
              <button onClick={() => openExport("srt")}>
                DaVinci Resolve字幕（SRT）
              </button>
              <button onClick={() => openExport("voicevox")}>
                VOICEVOX台本（CSV）
              </button>
              <button onClick={() => openExport("wav")}>
                VOICEVOX音声（WAV）
              </button>
              <button onClick={() => openExport("movie")}>
                カット別ムービー（MP4 ZIP）
              </button>
            </div>
          )}
        </nav>
        <input
          ref={fileRef}
          hidden
          type="file"
          accept=".txt,.md,.json,.ssp.json,.docx,.pdf"
          onChange={(e) => {
            void importFile(e.target.files?.[0]);
            e.currentTarget.value = "";
          }}
        />
      </header>
      <section className="controlbar">
        <div className="summary">
          <strong>{sections.length}</strong>
          <span>カット</span>
          <button className="normalize-inline" onClick={normalize}>
            番号を正規化
          </button>
          <i />
          <strong>
            {mode === "frames" ? plus(total) : `${(total / FPS).toFixed(2)}秒`}
          </strong>
          <span>総尺 · {runtime(total)}</span>
        </div>
        <label>
          尺表示
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "frames" | "seconds")}
          >
            <option value="frames">24f 秒＋コマ</option>
            <option value="seconds">秒</option>
          </select>
        </label>
        <label>
          発話速度
          <input
            type="range"
            min="1"
            max="12"
            step=".1"
            value={cps}
            onChange={(e) => setCps(+e.target.value)}
          />
          <b>{cps.toFixed(1)}</b>
          <span>音/秒</span>
        </label>
        <button className="speech-button" onClick={toggleSpeech}>
          {speaking ? "■ 音声停止" : "▶ セリフ再生"}
        </button>
        <button className="speech-button" onClick={() => setPlaybackOpen(true)}>
          再生設定
        </button>
        <label>
          文字
          <input
            type="range"
            min="12"
            max="26"
            value={fontSize}
            onChange={(e) => setFontSize(+e.target.value)}
          />
          <b>{fontSize}</b>
          <span>px</span>
        </label>
      </section>
      <section
        ref={workspaceRef}
        className={`workspace ${dragId || resizeId || sceneDragId || sceneWidthDragging || splitDragging ? "is-dragging" : ""}`}
        style={
          {
            "--editor-font": `${fontSize}px`,
            "--editor-lines": lines,
            "--scene-lines": sceneDisplayLines,
            "--scene-width": `${sceneWidth}px`,
          } as React.CSSProperties
        }
      >
        <div
          ref={scenePanelRef}
          className="scene-panel editor-panel"
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest(".scene-divider")) return;
            const rect = e.currentTarget.getBoundingClientRect(),
              maxRow = Math.max(
                sceneDisplayLines - 1,
                Math.floor((rect.height - 42) / (fontSize * 1.55)) - 1,
              ),
              row = Math.max(
                0,
                Math.min(
                  maxRow,
                  Math.floor((e.clientY - rect.top - 42) / (fontSize * 1.55)),
                ),
              );
            addSceneDivider(row);
          }}
        >
          <div className="panel-head">
            <b>シーン</b>
            <span>SCENE</span>
            <button
              type="button"
              className="scene-add-button"
              title="シーンを追加"
              aria-label="シーンを追加"
              onClick={() =>
                addSceneDivider(
                  sceneDividers.length
                    ? Math.max(...sceneDividers.map((divider) => divider.line)) + 4
                    : 0,
                )
              }
            >
              ＋
            </button>
          </div>
          <div className="scene-tints" aria-hidden="true">
            {sceneDividers.map((divider, index) => {
              const nextLine =
                sceneDividers[index + 1]?.line ?? sceneDisplayLines;
              return (
                <i
                  key={divider.id}
                  style={{
                    top: `calc(${divider.line} * var(--editor-font) * 1.55)`,
                    height: `calc(${Math.max(1, nextLine - divider.line)} * var(--editor-font) * 1.55)`,
                    backgroundColor: `${divider.color}18`,
                  }}
                />
              );
            })}
          </div>
          {!sceneDividers.length && (
            <p className="scene-empty-hint">
              ダブルクリックまたは「＋」で追加
            </p>
          )}
          {sceneDividers.map((divider, index) => {
            const nextLine =
              sceneDividers[index + 1]?.line ?? sceneDisplayLines;
            return (
              <textarea
                key={`${divider.id}-text`}
                className="scene-section-editor"
                wrap="off"
                spellCheck={false}
                value={divider.text}
                style={{
                  top: `calc(42px + ${divider.line} * var(--editor-font) * 1.55 + 20px)`,
                  height: `max(24px, calc(${Math.max(1, nextLine - divider.line)} * var(--editor-font) * 1.55 - 20px))`,
                }}
                onChange={(e) =>
                  setSceneDividers((current) =>
                    current.map((item) =>
                      item.id === divider.id
                        ? { ...item, text: e.target.value }
                        : item,
                    ),
                  )
                }
              />
            );
          })}
          {sceneDividers.map((divider) => (
            <div
              key={divider.id}
              role="button"
              tabIndex={0}
              className="scene-divider"
              title="ドラッグで移動・右クリックで色変更"
              style={{
                top: `calc(42px + ${divider.line} * var(--editor-font) * 1.55)`,
                backgroundColor: divider.color,
              }}
              onPointerDown={(e) => beginSceneDrag(e, divider.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSceneDragId(null);
                e.currentTarget
                  .querySelector<HTMLInputElement>('input[type="color"]')
                  ?.click();
              }}
            >
              <span>SCENE</span>
              <button
                type="button"
                className="scene-delete-button"
                title="シーンを削除"
                aria-label="シーンを削除"
                onPointerDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSceneDividers((current) =>
                    current.filter((item) => item.id !== divider.id),
                  );
                }}
              >
                ×
              </button>
              <input
                type="color"
                value={divider.color}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  setSceneDividers((current) =>
                    current.map((item) =>
                      item.id === divider.id
                        ? { ...item, color: e.target.value }
                        : item,
                    ),
                  )
                }
              />
            </div>
          ))}
        </div>
        <div
          className="scene-column-divider"
          role="separator"
          aria-label="シーン欄の横幅を調整"
          aria-orientation="vertical"
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setSceneWidthDragging(true);
          }}
        />
        <aside className="rail">
          <span>CUT</span>
          {Array.from({ length: lines }, (_, i) => {
            const section = sections.find((item) => item.start === i),
              cut = sortedCuts.find((item) => item.line === i),
              editId = i === 0 ? "first-cut" : cut?.id;
            return (
            <div key={i} className="rail-row">
              {section && editId && (
                editingCutNameId === editId ? (
                  <input
                    className="cut-name-input"
                    value={cutNameDraft}
                    autoFocus
                    onChange={(e) => setCutNameDraft(e.target.value)}
                    onBlur={commitCutName}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitCutName();
                      if (e.key === "Escape") setEditingCutNameId(null);
                    }}
                  />
                ) : (
                <button
                  className={`cut-badge ${
                    sortedCuts.some(
                      (item) => item.line === i && selectedCutIds.has(item.id),
                    )
                      ? "selected"
                      : ""
                  }`}
                  title="ドラッグで移動"
                  onPointerDown={(e) => {
                    if (cut) beginDrag(e, cut.id);
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragId(null);
                    startCutNameEdit(editId, section.name);
                  }}
                  onClick={(e) => {
                    if (e.shiftKey) return;
                    const c = sortedCuts.find((x) => x.line === i);
                    if (c) setSelectedCutIds(new Set([c.id]));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const c = sortedCuts.find((x) => x.line === i);
                    if (c)
                      setCuts((value) => value.filter((x) => x.id !== c.id));
                  }}
                >
                  {section.name}
                </button>
                )
              )}
            </div>
            );
          })}
        </aside>
        <div className="editor-panel">
          <div className="panel-head">
            <b>ト書き</b>
            <span>ACTION / SCENE</span>
          </div>
          <textarea
            ref={actionRef}
            wrap="off"
            spellCheck={false}
            value={action}
            onChange={(e) =>
              sync("action", e.target.value, e.target.selectionStart)
            }
          />
        </div>
        <div
          className="column-divider"
          role="separator"
          aria-label="ト書きとセリフの幅を調整"
          aria-orientation="vertical"
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setSplitDragging(true);
          }}
        />
        <div ref={cutLayerRef} className="cut-layer">
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} className="cut-row">
              {!sortedCuts.some((c) => c.line === i) && (
                <button
                  className="add-line"
                  onClick={() => addCut(i)}
                  title="カット区切りを追加"
                  aria-label="カット区切りを追加"
                >
                  ◀⊕
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="editor-panel dialogue">
          <div className="panel-head">
            <b>セリフ</b>
            <span>DIALOGUE · [話者]セリフ</span>
          </div>
          <textarea
            ref={dialogueRef}
            className={speaking ? "speech-active" : undefined}
            wrap="off"
            spellCheck={false}
            value={dialogue}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey) {
                dialogueEnterRef.current = null;
                return;
              }
              const value = e.currentTarget.value,
                position = e.currentTarget.selectionStart,
                lineStart = value.lastIndexOf("\n", position - 1) + 1,
                foundEnd = value.indexOf("\n", position),
                lineEnd = foundEnd < 0 ? value.length : foundEnd,
                line = value.slice(lineStart, lineEnd),
                parsed = parseDialogue(line),
                close = Math.max(line.indexOf("]"), line.indexOf("］")),
                cursorInsideBody = close >= 0 && position > lineStart + close,
                textAfterCursor = value.slice(position, lineEnd).trim();
              dialogueEnterRef.current = {
                speaker: parsed?.speaker ?? "",
                inherit: Boolean(
                  parsed && cursorInsideBody && textAfterCursor.length > 0,
                ),
              };
            }}
            onChange={(e) =>
              sync("dialogue", e.target.value, e.target.selectionStart)
            }
          />
        </div>
        {sortedCuts.map((cut) => {
          const height = Math.max(0, cut.trimRows ?? 0),
            section = sections.find((s) => s.end === cut.line);
          return (
            <div
              key={cut.id}
              className={`cut-overlay ${selectedCutIds.has(cut.id) ? "selected" : ""}`}
              style={{
                top: `calc(18px + 42px + ${cut.line} * var(--editor-font) * 1.55)`,
                height: `calc(${height} * var(--editor-font) * 1.55)`,
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCuts((value) => value.filter((item) => item.id !== cut.id));
                setSelectedCutIds((value) => {
                  const next = new Set(value);
                  next.delete(cut.id);
                  return next;
                });
              }}
            >
              <div className="cut-overlay-band" />
              <div className="cut-overlay-rule" />
              <div className="cut-overlay-controls">
                {editingDurationId === cut.id ? (
                  <input
                    className="duration-handle duration-input"
                    value={durationDraft}
                    autoFocus
                    onChange={(e) => setDurationDraft(e.target.value)}
                    onBlur={() => commitDuration(cut)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitDuration(cut);
                      if (e.key === "Escape") setEditingDurationId(null);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <button
                    className="duration-handle"
                    title="ドラッグで移動・ダブルクリックで尺を編集・右クリックで削除"
                    onPointerDown={(e) => beginDrag(e, cut.id)}
                    onClick={(e) => {
                      if (!e.shiftKey) setSelectedCutIds(new Set([cut.id]));
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragId(null);
                      startDurationEdit(cut, section?.frames ?? 0);
                    }}
                  >
                    {mode === "frames"
                      ? plus(section?.frames ?? 0)
                      : `${((section?.frames ?? 0) / FPS).toFixed(2)}秒`}
                  </button>
                )}
                <button
                  className="overlay-resize"
                  title="ドラッグして幅を変更"
                  onPointerDown={(e) => beginResize(e, cut.id)}
                >
                  ▼
                </button>
              </div>
            </div>
          );
        })}
        <div
          className="cut-overlay last-duration"
          style={{
            top: `calc(18px + 42px + ${lines} * var(--editor-font) * 1.55)`,
            height: 0,
          }}
        >
          <div className="cut-overlay-rule" />
          <div className="cut-overlay-controls">
            <span className="duration-handle final-duration">
              最終{" "}
              {mode === "frames"
                ? plus(sections.at(-1)?.frames ?? 0)
                : `${((sections.at(-1)?.frames ?? 0) / FPS).toFixed(2)}秒`}
            </span>
          </div>
        </div>
      </section>
      <footer>
        <span className="ready-dot" />
        {busy || "カット番号／区切りバーはドラッグで移動できます"}
      </footer>
      {exportKind && (
        <div
          className="modal-backdrop"
          onPointerDown={() => setExportKind(null)}
        >
          <section
            className="export-dialog"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <h2>
              {exportKind === "xdts"
                ? "XDTS＋セリフボールド"
                : exportKind === "storyboard"
                  ? "コンテ用画像"
                  : exportKind === "wav"
                    ? "VOICEVOX音声（WAV）"
                    : exportKind === "movie"
                      ? "カット別ムービー（MP4 ZIP）"
                  : "保存・書き出し"}
            </h2>
            <label>
              書き出し名
              <input
                value={exportName}
                onChange={(e) => setExportName(e.target.value)}
                autoFocus
              />
            </label>
            {exportKind === "wav" && (
              <p className="setting-help">
                再生設定で接続したVOICEVOXと話者スタイルを使用し、改行の間を含む一本のWAVを書き出します。
              </p>
            )}
            {exportKind === "movie" && (
              <div className="story-settings">
                <p className="setting-help">
                  1920×1080・24fps・H.264＋AACのMP4をカットごとに生成し、ZIPにまとめます。
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={movieDialogueBold}
                    onChange={(e) => setMovieDialogueBold(e.target.checked)}
                  />
                  セリフボールドを追加する
                </label>
                {movieDialogueBold && (
                  <div className="color-settings">
                    <b>話者別セリフボールドの色</b>
                    {speakers.map((speaker, index) => (
                      <label key={speaker}>
                        <span>[{speaker}]</span>
                        <input
                          type="color"
                          value={
                            speakerColors[speaker] ?? colors[index % colors.length]
                          }
                          onChange={(e) =>
                            setSpeakerColors((current) => ({
                              ...current,
                              [speaker]: e.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                )}
                {movieDialogueBold && (
                  <p className="setting-help">
                    VOICEVOX音声の発話中だけ、画面中央より少し左下に表示します。
                  </p>
                )}
              </div>
            )}
            {exportKind === "xdts" && (
              <div className="color-settings">
                <b>セリフボールドの色</b>
                {speakers.map((speaker, i) => (
                  <label key={speaker}>
                    <span>[{speaker}]</span>
                    <input
                      type="color"
                      value={
                        speakerColors[speaker] ?? colors[i % colors.length]
                      }
                      onChange={(e) =>
                        setSpeakerColors((v) => ({
                          ...v,
                          [speaker]: e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            )}
            {exportKind === "storyboard" && (
              <div className="story-settings">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={includeAction}
                    onChange={(e) => setIncludeAction(e.target.checked)}
                  />
                  ト書きあり
                </label>
                <label>
                  1画像のマス目数
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={gridCount}
                    onChange={(e) =>
                      setGridCount(Math.max(1, Math.min(100, +e.target.value)))
                    }
                  />
                </label>
              </div>
            )}
            <div className="dialog-actions">
              <button onClick={() => setExportKind(null)}>キャンセル</button>
              <button
                className="confirm"
                disabled={!exportName.trim()}
                onClick={runExport}
              >
                書き出す
              </button>
            </div>
          </section>
        </div>
      )}
      {importSettingsOpen && (
        <div
          className="modal-backdrop"
          onPointerDown={() => setImportSettingsOpen(false)}
        >
          <section
            className="export-dialog import-dialog"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <h2>読み込み設定</h2>
            <p className="setting-help">Aを名前、Bをセリフとして認識します。</p>
            <div className="pattern-list">
              {dialoguePatterns.map((pattern) => (
                <div key={pattern}>
                  <code>{pattern}</code>
                  <button
                    onClick={() =>
                      setDialoguePatterns((value) =>
                        value.filter((item) => item !== pattern),
                      )
                    }
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>
            <div className="pattern-add">
              <input
                value={patternDraft}
                onChange={(e) => setPatternDraft(e.target.value)}
                placeholder="例：A「B」"
              />
              <button
                onClick={() => {
                  const value = patternDraft.trim();
                  if (
                    value.includes("A") &&
                    value.includes("B") &&
                    !dialoguePatterns.includes(value)
                  ) {
                    setDialoguePatterns((current) => [...current, value]);
                    setPatternDraft("");
                  }
                }}
              >
                登録
              </button>
            </div>
            <b>セリフ内の改行</b>
            <div className="break-settings">
              <label>
                <input
                  type="checkbox"
                  checked={breakComma}
                  onChange={(e) => setBreakComma(e.target.checked)}
                />
                読点（、）
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={breakPeriod}
                  onChange={(e) => setBreakPeriod(e.target.checked)}
                />
                句点（。）
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={breakMarks}
                  onChange={(e) => setBreakMarks(e.target.checked)}
                />
                ！？
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={breakEllipsis}
                  onChange={(e) => setBreakEllipsis(e.target.checked)}
                />
                …／・・・
              </label>
            </div>
            <div className="dialog-actions">
              <button
                className="confirm"
                onClick={() => setImportSettingsOpen(false)}
              >
                設定を閉じる
              </button>
            </div>
          </section>
        </div>
      )}
      {playbackOpen && (
        <div
          className="modal-backdrop"
          onPointerDown={() => setPlaybackOpen(false)}
        >
          <section
            className="export-dialog playback-dialog"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <h2>セリフ再生設定</h2>
            <div className="voice-engine-settings">
              <b>音声エンジン</b>
              <div className="engine-options">
                <label>
                  <input
                    type="radio"
                    name="playback-engine"
                    checked={playbackEngine === "browser"}
                    onChange={() => setPlaybackEngine("browser")}
                  />
                  ブラウザ標準音声
                </label>
                <label>
                  <input
                    type="radio"
                    name="playback-engine"
                    checked={playbackEngine === "voicevox"}
                    disabled={!voicevoxStyles.length}
                    onChange={() => setPlaybackEngine("voicevox")}
                  />
                  VOICEVOX
                </label>
                <button
                  type="button"
                  className="voicevox-help-link"
                  onClick={() => setVoicevoxHelpOpen(true)}
                >
                  設定
                </button>
              </div>
              <label className="voicevox-address">
                <span>VOICEVOX Engine</span>
                <input
                  type="url"
                  value={voicevoxUrl}
                  spellCheck={false}
                  onChange={(e) => setVoicevoxUrl(e.target.value)}
                />
                <button onClick={() => void connectVoicevox()}>接続確認</button>
              </label>
              <small
                className={
                  voicevoxStyles.length ? "connection-ok" : "connection-status"
                }
              >
                {voicevoxStatus}
              </small>
              {voicevoxStyles.length > 0 && speakers.length > 0 && (
                <div className="voicevox-mapping">
                  <b>話者別VOICEVOXスタイル</b>
                  {speakers.map((speaker) => (
                    <label key={speaker}>
                      <span
                        className="speaker-color-name"
                        style={{
                          backgroundColor:
                            speakerColors[speaker] ??
                            colors[speakers.indexOf(speaker) % colors.length],
                        }}
                      >
                        [{speaker}]
                      </span>
                      <select
                        value={
                          voicevoxSpeakerStyles[speaker] ?? voicevoxStyles[0].id
                        }
                        onChange={(e) =>
                          setVoicevoxSpeakerStyles((current) => ({
                            ...current,
                            [speaker]: Number(e.target.value),
                          }))
                        }
                      >
                        {voicevoxStyles.map((style) => (
                          <option key={style.id} value={style.id}>
                            {style.speaker}（{style.name}）
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={syncPlaybackRate}
                onChange={(e) => setSyncPlaybackRate(e.target.checked)}
              />
              発話速度と尺に合わせる
            </label>
            <label>
              再生速度
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.05"
                value={playbackRate}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
              />
              <b>{playbackRate.toFixed(2)}倍</b>
            </label>
            {speakers.length > 0 && (
              <div className="color-settings playback-color-settings">
                <b>話者別セリフボールド色</b>
                {speakers.map((speaker, index) => (
                  <label key={speaker}>
                    <span
                      className="speaker-color-name"
                      style={{
                        backgroundColor:
                          speakerColors[speaker] ?? colors[index % colors.length],
                      }}
                    >
                      [{speaker}]
                    </span>
                    <input
                      type="color"
                      value={
                        speakerColors[speaker] ?? colors[index % colors.length]
                      }
                      onChange={(e) =>
                        setSpeakerColors((current) => ({
                          ...current,
                          [speaker]: e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            )}
            {playbackEngine === "browser" && <div className="pitch-settings">
              <b>話者別の音声ピッチ</b>
              {speakers.map((speaker) => (
                <label key={speaker}>
                  <span
                    className="speaker-color-name"
                    style={{
                      backgroundColor:
                        speakerColors[speaker] ??
                        colors[speakers.indexOf(speaker) % colors.length],
                    }}
                  >
                    [{speaker}]
                  </span>
                  <input
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.05"
                    value={speakerPitch[speaker] ?? 1}
                    onChange={(e) =>
                      setSpeakerPitch((current) => ({
                        ...current,
                        [speaker]: Number(e.target.value),
                      }))
                    }
                  />
                  <b>{(speakerPitch[speaker] ?? 1).toFixed(2)}</b>
                </label>
              ))}
            </div>}
            <p className="setting-help">
              再生はセリフ欄のカーソル位置から始まり、話者名は読み上げません。VOICEVOXを使う場合は、VOICEVOXを起動してから接続確認を押してください。
            </p>
            <div className="dialog-actions">
              <button
                className="confirm"
                onClick={() => setPlaybackOpen(false)}
              >
                設定を閉じる
              </button>
            </div>
          </section>
        </div>
      )}
      {voicevoxHelpOpen && (
        <div
          className="modal-backdrop voicevox-help-backdrop"
          onPointerDown={() => setVoicevoxHelpOpen(false)}
        >
          <section
            className="export-dialog voicevox-help-dialog"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <h2>VOICEVOX接続設定</h2>
            <ol>
              <li>
                <a
                  href="http://127.0.0.1:50021/setting"
                  target="_blank"
                  rel="noreferrer"
                >
                  VOICEVOX Engine設定
                </a>
                を開きます。
              </li>
              <li>
                <b>CORS Policy Mode</b> は <code>localapps</code> のままにします。
              </li>
              <li>
                <b>Allow Origin</b> に
                <code>https://koji2make20.github.io</code>
                を入力します。
              </li>
            </ol>
            <p className="setting-help">
              設定後はVOICEVOXを完全に終了して再起動し、この画面の「接続確認」を押してください。URL末尾の
              /Storyborad-script-Organaizer/ は入力しません。
            </p>
            <div className="dialog-actions">
              <button
                className="confirm"
                onClick={() => setVoicevoxHelpOpen(false)}
              >
                閉じる
              </button>
            </div>
          </section>
        </div>
      )}
      {busy && (
        <div className="busy">
          <div />
          <b>{busy}</b>
        </div>
      )}
    </main>
  );
}
