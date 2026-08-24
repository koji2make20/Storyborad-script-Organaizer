"use client";

import { useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { jsPDF } from "jspdf";

type Cut = {
  id: string;
  name: string;
  line: number;
  trimRows?: number;
  frames?: number;
  manual?: boolean;
};
type Section = { start: number; end: number; name: string; frames: number };
type ExportKind =
  | "project"
  | "pdf"
  | "xdts"
  | "storyboard"
  | "srt"
  | "voicevox"
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
  for (const ch of text.replace(/^\s*[［\[][^\]］]+[\]］]/gm, "")) {
    if (ch === "。" || ch === "\n") fixed += 12;
    else if ("、，…".includes(ch)) fixed += 6;
    else if ("！？!?".includes(ch)) fixed += 8;
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
    [cps, setCps] = useState(8),
    [mode, setMode] = useState<"frames" | "seconds">("frames"),
    [cuts, setCuts] = useState<Cut[]>([
      { id: "cut-1", name: "2", line: 5, trimRows: 0 },
    ]),
    [fontSize, setFontSize] = useState(15),
    [menu, setMenu] = useState(false),
    [busy, setBusy] = useState(""),
    [dragId, setDragId] = useState<string | null>(null),
    [resizeId, setResizeId] = useState<string | null>(null),
    [exportKind, setExportKind] = useState<ExportKind>(null),
    [exportName, setExportName] = useState("storyboard"),
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
    [breakEllipsis, setBreakEllipsis] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null),
    cutLayerRef = useRef<HTMLDivElement>(null);
  const lines = Math.max(
      action.split("\n").length,
      dialogue.split("\n").length,
      1,
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
        );
    return marks.slice(0, -1).map((start, i) => {
      const cut = i ? sortedCuts[i - 1] : undefined,
        endCut = sortedCuts[i],
        end = marks[i + 1],
        text = dialogueLines
          .slice(start, end)
          .filter((_, n) => !isTrimmed(start + n))
          .join("\n"),
        auto = readingFrames(text, cps) + (endCut?.trimRows ?? 0) * 12;
      return {
        start,
        end,
        name: i ? (cut?.name ?? String(i + 1)) : "1",
        frames: endCut?.manual && endCut.frames != null ? endCut.frames : auto,
      };
    });
  }, [sortedCuts, lines, dialogue, cps]);
  const total = sections.reduce((n, s) => n + s.frames, 0);
  const speakers = useMemo(() => {
    const list: string[] = [];
    dialogueLines.forEach((l) => {
      const p = parseDialogue(l);
      if (p && !list.includes(p.speaker)) list.push(p.speaker);
    });
    return list;
  }, [dialogue]);

  const sync = (side: "action" | "dialogue", value: string) => {
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
    if (side === "dialogue" && delta > 0) {
      const prefix =
        parseDialogue(oldLines[Math.max(0, changed - 1)] ?? "")?.speaker ||
        parseDialogue(own[Math.max(0, changed - 1)] ?? "")?.speaker;
      if (prefix)
        for (let i = changed; i < Math.min(own.length, changed + delta); i++)
          if (!own[i].trim()) own[i] = `[${prefix}]`;
    }
    if (delta !== 0)
      setCuts((current) => {
        const shifted = current.map((c) => {
          if (delta > 0 && c.line > changed)
            return { ...c, line: c.line + delta };
          if (delta < 0) {
            const deletedTo = changed - delta;
            if (c.line >= deletedTo)
              return { ...c, line: Math.max(1, c.line + delta) };
            if (c.line > changed) return { ...c, line: Math.max(1, changed) };
          }
          return c;
        });
        const byLine = new Map<number, Cut>();
        for (const c of shifted)
          byLine.set(c.line, {
            ...(byLine.get(c.line) ?? c),
            ...c,
            trimRows: Math.max(
              byLine.get(c.line)?.trimRows ?? 0,
              c.trimRows ?? 0,
            ),
          });
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
  };
  const normalize = () =>
    setCuts((v) =>
      [...v]
        .sort((a, b) => a.line - b.line)
        .map((c, i) => ({ ...c, name: String(i + 2) })),
    );
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
      return [
        ...ordered,
        { id: crypto.randomUUID(), name: after, line, trimRows: 0 },
      ].sort((a, b) => a.line - b.line);
    });
  const moveCut = (id: string, line: number) =>
    setCuts((v) => {
      const moving = v.find((c) => c.id === id);
      if (!moving) return v;
      const without = v.filter((c) => c.id !== id && c.line !== line);
      return [...without, { ...moving, line, manual: false }].sort(
        (a, b) => a.line - b.line,
      );
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
    if (dragId) moveCut(dragId, row);
    if (resizeId)
      setCuts((v) =>
        v.map((c) =>
          c.id === resizeId ? { ...c, trimRows: Math.max(0, row - c.line) } : c,
        ),
      );
  };
  const beginDrag = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragId(id);
  };
  const beginResize = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setResizeId(id);
  };
  const editDuration = (cut: Cut, currentFrames: number) => {
    const initial = plus(
        cut.manual && cut.frames != null ? cut.frames : currentFrames,
      ),
      input = window.prompt("尺を「秒＋コマ」で入力してください", initial);
    if (input == null) return;
    const match = input
      .trim()
      .replaceAll("＋", "+")
      .match(/^(\d+)(?:\+(\d+))?$/);
    if (!match || (match[2] != null && Number(match[2]) >= FPS)) {
      window.alert("例：4+12 の形式で入力してください（コマは0〜23）。");
      return;
    }
    const frames =
      match[2] == null
        ? Number(match[1])
        : Number(match[1]) * FPS + Number(match[2]);
    setCuts((value) =>
      value.map((item) =>
        item.id === cut.id ? { ...item, frames, manual: true } : item,
      ),
    );
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
        setCuts(
          (p.cuts ?? []).map(
            (
              c: Cut & { block_no?: number; trim_rows?: number },
              i: number,
            ) => ({
              ...c,
              id: c.id ?? crypto.randomUUID(),
              name: c.name ?? p.cut_names?.[i + 1] ?? String(i + 2),
              line: c.line ?? c.block_no ?? 0,
              trimRows: c.trimRows ?? c.trim_rows ?? 0,
            }),
          ),
        );
        return;
      }
      let text = "";
      if (ext === "docx") {
        const module = await import("mammoth/mammoth.browser"),
          mammoth = (module as any).default ?? module;
        text = (
          await mammoth.extractRawText({
            arrayBuffer: await file.arrayBuffer(),
          })
        ).value;
        if (!text.trim())
          throw new Error("Word文書から文字を取得できませんでした。");
      } else if (ext === "pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
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
      setCuts([]);
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "読み込みに失敗しました。",
      );
    } finally {
      setBusy("");
    }
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
        cuts: sortedCuts,
        cut_names: sections.map((s) => s.name),
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
  const boardPng = async (speaker: string, color: string) => {
    const c = document.createElement("canvas"),
      ctx = c.getContext("2d")!;
    ctx.font = 'bold 52px "Yu Gothic UI",sans-serif';
    const w = Math.ceil(ctx.measureText(speaker).width) + 64;
    c.width = w;
    c.height = 96;
    ctx.fillStyle = color;
    ctx.roundRect(2, 2, w - 4, 92, 12);
    ctx.fill();
    ctx.font = 'bold 52px "Yu Gothic UI",sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#000";
    ctx.strokeText(speaker, w / 2, 48);
    ctx.fillStyle = "#fff";
    ctx.fillText(speaker, w / 2, 48);
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
          entries = dialogueLines
            .slice(s.start, s.end)
            .map(parseDialogue)
            .filter((x): x is NonNullable<typeof x> => !!x && !!x.body),
          dialogFrames: object[] = [];
        let cursor = 0;
        for (const item of entries) {
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
          entries = dialogueLines
            .slice(s.start, s.end)
            .map(parseDialogue)
            .filter((x): x is NonNullable<typeof x> => !!x && !!x.body),
          dialogFrames: object[] = [];
        let cursor = 0;
        for (const item of entries) {
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
        const dtext = dialogueLines
          .slice(s.start, s.end)
          .map(parseDialogue)
          .filter(Boolean)
          .map((p) => `[${p!.speaker}]\n${p!.body}`)
          .join("\n");
        drawBoxText(
          ctx,
          dtext,
          dx + 18,
          top + 18,
          square - 36,
          h - 36,
          24,
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
      download(`${name}.ssp.json`, project(), "application/json");
    else if (exportKind === "pdf") await exportPdf();
    else if (exportKind === "xdts") await exportXdtsNamed();
    else if (exportKind === "storyboard") await exportStoryboard();
    else if (exportKind === "srt") download(`${name}.srt`, srt());
    else if (exportKind === "voicevox")
      download(`${name}.csv`, "\ufeff" + voicevox(), "text/csv;charset=utf-8");
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
      onPointerMove={dragMove}
      onPointerUp={() => {
        setDragId(null);
        setResizeId(null);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <span className="mark">SC</span>
          <div>
            <b>Storyboard Script Organizer</b>
            <small>WEB EDITION · v0.48 LIGHT BASE</small>
          </div>
        </div>
        <nav>
          <button onClick={() => fileRef.current?.click()}>読み込む</button>
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
            </div>
          )}
        </nav>
        <input
          ref={fileRef}
          hidden
          type="file"
          accept=".txt,.md,.json,.ssp.json,.docx,.pdf"
          onChange={(e) => importFile(e.target.files?.[0])}
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
        <label>
          左右幅 ↔
          <input
            type="range"
            min="25"
            max="75"
            value={split}
            onChange={(e) => setSplit(+e.target.value)}
          />
        </label>
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
        className={`workspace ${dragId || resizeId ? "is-dragging" : ""}`}
        style={{ "--editor-font": `${fontSize}px` } as React.CSSProperties}
      >
        <aside className="rail">
          <span>CUT</span>
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} className="rail-row">
              {sections.find((s) => s.start === i) && (
                <button
                  className="cut-badge"
                  title="ドラッグで移動"
                  onPointerDown={(e) => {
                    const c = sortedCuts.find((x) => x.line === i);
                    if (c) beginDrag(e, c.id);
                  }}
                >
                  {sections.find((s) => s.start === i)?.name}
                </button>
              )}
            </div>
          ))}
        </aside>
        <div className="editor-panel">
          <div className="panel-head">
            <b>ト書き</b>
            <span>ACTION / SCENE</span>
          </div>
          <textarea
            wrap="off"
            spellCheck={false}
            value={action}
            onChange={(e) => sync("action", e.target.value)}
          />
        </div>
        <div ref={cutLayerRef} className="cut-layer">
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} className="cut-row">
              {!sortedCuts.some((c) => c.line === i) && (
                <button
                  className="add-line"
                  onClick={() => addCut(i)}
                  title="カット区切りを追加"
                >
                  ＋
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
            wrap="off"
            spellCheck={false}
            value={dialogue}
            onChange={(e) => sync("dialogue", e.target.value)}
          />
        </div>
        {sortedCuts.map((cut) => {
          const height = Math.max(0, cut.trimRows ?? 0),
            section = sections.find((s) => s.end === cut.line);
          return (
            <div
              key={cut.id}
              className="cut-overlay"
              style={{
                top: `calc(18px + 42px + ${cut.line} * var(--editor-font) * 1.55)`,
                height: `calc(${height} * var(--editor-font) * 1.55)`,
              }}
            >
              <div className="cut-overlay-band" />
              <div className="cut-overlay-rule" />
              <div className="cut-overlay-controls">
                <button
                  className="duration-handle"
                  title="ドラッグで区切り移動・ダブルクリックで尺を編集"
                  onPointerDown={(e) => beginDrag(e, cut.id)}
                  onDoubleClick={() => editDuration(cut, section?.frames ?? 0)}
                >
                  {mode === "frames"
                    ? plus(section?.frames ?? 0)
                    : `${((section?.frames ?? 0) / FPS).toFixed(2)}秒`}
                </button>
                <button
                  className="overlay-resize"
                  style={{
                    top: `calc(22px + ${height} * var(--editor-font) * 1.55)`,
                  }}
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
      {busy && (
        <div className="busy">
          <div />
          <b>{busy}</b>
        </div>
      )}
    </main>
  );
}
