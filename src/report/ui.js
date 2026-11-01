/* Terminal UI Bench report app. Plain browser JS, no build step. */
"use strict";

const DEF_FG = "#d4d4d4";
const DEF_BG = "#1e1e1e";
const MAX_FONT = 13;
const LS_JUDGE = "tuibench.judge";
const LS_JUDGMENTS = "tuibench.judgments";
const LS_PREFS = "tuibench.prefs";

const S = {
  data: null,
  judgments: [],
  entriesById: new Map(),
  standalone: !!(window.TUIBENCH && window.TUIBENCH.standalone),
};

/* ---------- tiny DOM helper ---------- */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);

function prefs() {
  try { return JSON.parse(localStorage.getItem(LS_PREFS) || "{}"); } catch { return {}; }
}
function setPref(k, v) {
  try { localStorage.setItem(LS_PREFS, JSON.stringify({ ...prefs(), [k]: v })); } catch {}
}

/* ---------- data ---------- */
async function loadData() {
  if (S.standalone) {
    S.data = window.TUIBENCH.data;
    let local = [];
    try { local = JSON.parse(localStorage.getItem(LS_JUDGMENTS) || "[]"); } catch {}
    const byId = new Map();
    for (const j of [...(window.TUIBENCH.judgments || []), ...local]) byId.set(j.id, j);
    for (const id of deletedLocal()) byId.delete(id);
    S.judgments = [...byId.values()];
  } else {
    S.data = await (await fetch("data.json", { cache: "no-store" })).json();
    S.judgments = await (await fetch("api/judgments", { cache: "no-store" })).json().catch(() => []);
  }
  for (const e of S.data.entries) S.entriesById.set(e.id, e);
}
function deletedLocal() {
  try { return JSON.parse(localStorage.getItem(LS_JUDGMENTS + ".deleted") || "[]"); } catch { return []; }
}
function persistLocal() {
  try { localStorage.setItem(LS_JUDGMENTS, JSON.stringify(S.judgments)); } catch {}
}
async function addJudgment(j) {
  S.judgments.push(j);
  if (S.standalone) return persistLocal();
  const r = await fetch("api/judgments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "add", judgment: j }) });
  if (!r.ok) toast(`Your vote was not saved (server answered ${r.status}). Check that tuibench serve is still running.`);
}
async function deleteJudgment(id) {
  S.judgments = S.judgments.filter((j) => j.id !== id);
  if (S.standalone) {
    try { localStorage.setItem(LS_JUDGMENTS + ".deleted", JSON.stringify([...deletedLocal(), id])); } catch {}
    return persistLocal();
  }
  await fetch("api/judgments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "del", id }) });
}

const task = (id) => S.data.tasks.find((t) => t.id === id);
const stackTitle = (id) => (S.data.stacks.find((s) => s.id === id) || { title: id }).title;
const modelName = (id) => (S.data.models.find((m) => m.id === id) || { name: id }).name;
const entryLabel = (e) => `${modelName(e.model)} · ${stackTitle(e.stack)}`;
const entriesFor = (taskId) => S.data.entries.filter((e) => e.task === taskId);
function judgeName() {
  try { return (localStorage.getItem(LS_JUDGE) || "").trim() || "anonymous"; } catch { return "anonymous"; }
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/** Overall status of an entry, independent of who built it (safe to show in blind mode). */
function status(e) {
  const c = e.capture;
  if (!e.meta.build || !e.meta.build.ok) return { kind: "bad", text: "build failed", broken: true };
  if (!c) return { kind: "warn", text: "not captured", broken: true };
  if (!c.started || c.snapshotCount === 0) return { kind: "bad", text: c.error || "did not start", broken: true };
  if (c.crashed) return { kind: "bad", text: "crashed", broken: false };
  if (c.cleanExit === false) return { kind: "warn", text: "quit uncleanly", broken: false };
  if (c.cleanExit === true) return { kind: "good", text: "ran & quit cleanly", broken: false };
  return { kind: "good", text: "ran", broken: false };
}
function statusChips(e) {
  const s = status(e);
  const chips = [h("span", { class: `chip ${s.kind}` }, s.text)];
  if (e.meta.build && e.meta.build.typecheckOk === false) chips.push(h("span", { class: "chip warn" }, "type errors"));
  return chips;
}

/* ---------- terminal snapshot rendering ---------- */
function blend(fg, bg, t) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const a = p(fg), b = p(bg);
  return "#" + a.map((v, i) => Math.round(v * t + b[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
}

function renderTerm(snap, marks) {
  const pre = h("pre");
  for (const line of snap.lines) {
    const ln = h("span", { class: "ln" });
    for (const r of line) {
      let fg = r.fg || DEF_FG;
      let bg = r.bg || null;
      if (r.v) { const f = fg; fg = bg || DEF_BG; bg = f; }
      if (r.d) fg = blend(fg, bg || DEF_BG, 0.55);
      const style = [];
      if (fg !== DEF_FG) style.push(`color:${fg}`);
      if (bg) style.push(`background:${bg}`);
      if (r.b) style.push("font-weight:700");
      if (r.i) style.push("font-style:italic");
      const deco = [r.u && "underline", r.s && "line-through"].filter(Boolean).join(" ");
      if (deco) style.push(`text-decoration:${deco}`);
      const attrs = {};
      if (style.length) attrs.style = style.join(";");
      if (r.w) attrs.class = "w";
      const content = r.w ? [r.t] : cellSafe(r.t);
      ln.append(style.length || r.w ? h("span", attrs, content) : h("span", {}, content));
    }
    pre.append(ln);
  }
  if (snap.cursor && snap.cursor.visible) {
    pre.append(h("span", { class: "cursor", style: { left: `${snap.cursor.x}ch`, top: `${snap.cursor.y * 1.2}em` } }));
  }
  if (marks && marks.length) pre.append(renderMarks(marks, snap.cols, snap.rows));
  const term = h("div", { class: "term" }, pre);
  const frame = h("div", { class: "term-frame", "data-cols": snap.cols }, term);
  fitFrame(frame, snap.cols);
  return frame;
}

// Characters the monospace font reliably draws exactly one cell wide: ASCII, Latin-1, box drawing and block
// elements. Anything else (braille, arrows, geometric shapes, symbols) may come from a fallback font with a
// different advance width, so it gets a fixed one-cell box to keep the grid aligned.
const SAFE_CHARS = /[\u0020-\u007e\u00a0-\u00ff\u2500-\u259f]+/y;
function cellSafe(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    SAFE_CHARS.lastIndex = i;
    const m = SAFE_CHARS.exec(text);
    if (m) {
      out.push(m[0]);
      i += m[0].length;
    } else {
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      out.push(h("span", { class: "c" }, ch));
      i += ch.length;
    }
  }
  return out;
}

let charRatio = null; // width of one monospace cell per px of font-size
function measureCharRatio() {
  if (charRatio) return charRatio;
  const probe = h("pre", { class: "mono", style: { position: "absolute", visibility: "hidden", fontSize: "100px", margin: 0, fontFamily: "var(--mono)" } }, "M".repeat(50));
  document.body.append(probe);
  charRatio = probe.getBoundingClientRect().width / 50 / 100 || 0.6;
  probe.remove();
  return charRatio;
}
const fitObserver = new ResizeObserver((entries) => {
  for (const en of entries) applyFit(en.target);
});
function applyFit(frame) {
  const cols = +frame.dataset.cols;
  const width = frame.clientWidth - 26; // term padding
  if (width <= 0) return;
  const fs = Math.min(MAX_FONT, width / (cols * measureCharRatio()));
  frame.style.setProperty("--fs", `${Math.max(4, Math.floor(fs * 100) / 100)}px`);
}
function fitFrame(frame) {
  fitObserver.observe(frame);
  requestAnimationFrame(() => applyFit(frame));
}

function emptyTerm(title, detail) {
  return h("div", { class: "term-empty" }, h("div", {}, title), detail ? h("pre", {}, detail) : null);
}

function snapshotOrPlaceholder(e, cpName, marks) {
  const snap = (e.snapshots || []).find((s) => s.name === cpName);
  if (snap) return renderTerm(snap, marks);
  const st = status(e);
  if (st.broken) return emptyTerm(st.text, e.buildLog ? e.buildLog.slice(-2500) : (e.capture && e.capture.error) || null);
  return emptyTerm("No screen at this checkpoint", (e.capture && e.capture.error) || "The app exited before reaching it.");
}

/* ---------- replay (asciicast via xterm.js) ---------- */
function parseCast(text) {
  const lines = text.split("\n").filter(Boolean);
  const header = JSON.parse(lines[0]);
  let events = lines.slice(1).map((l) => JSON.parse(l));
  // Align recordings on the app's first output so slower startups (e.g. JIT warmup) don't skew side-by-side playback.
  const first = events.find((e) => e[1] === "o");
  if (first) events = events.map(([t, c, d]) => [Math.max(0, t - first[0]), c, d]);
  // End shortly after the last checkpoint: after that the app quits and the screen is cleared.
  const markers = events.filter((e) => e[1] === "m");
  const end = events.length ? events[events.length - 1][0] : 0;
  return { header, events, duration: markers.length ? Math.min(end, markers[markers.length - 1][0] + 0.8) : end };
}
const KEY_NAMES = {
  "\r": "⏎", "\t": "⇥", "\x1b[Z": "⇧⇥", "\x1b": "esc", "\x7f": "⌫", " ": "␣",
  "\x1b[A": "↑", "\x1b[B": "↓", "\x1b[C": "→", "\x1b[D": "←", "\x1bOA": "↑", "\x1bOB": "↓", "\x1bOC": "→", "\x1bOD": "←",
  "\x1b[5~": "pgup", "\x1b[6~": "pgdn", "\x1b[H": "home", "\x1b[F": "end", "\x1b[3~": "del",
};
/** SGR mouse report → short label, or null for releases and motion (they are shown by the pointer). */
function mouseLabel(s) {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
  if (!m || m[4] === "m") return null;
  const b = +m[1];
  if (b >= 64) return b & 1 ? "scroll ↓" : "scroll ↑";
  if (b & 32) return null;
  return ["click", "middle-click", "right-click", ""][b & 3] || null;
}

function keyLabel(s) {
  if (KEY_NAMES[s]) return KEY_NAMES[s];
  if (s.length === 1 && s.charCodeAt(0) < 27) return "ctrl+" + String.fromCharCode(s.charCodeAt(0) + 96);
  if (s.startsWith("\x1b[200~")) return "paste";
  if (s.startsWith("\x1b[<")) return mouseLabel(s);
  if (s.length === 2 && s[0] === "\x1b") return "alt+" + s[1];
  return s.replace(/\x1b/g, "^[");
}

class CastPlayer {
  constructor(host, cast) {
    this.cast = cast;
    this.host = host;
    this.keysEl = h("div", { class: "keys" });
    this.markerEl = h("div", { class: "marker" });
    this.pointerEl = h("div", { class: "pointer" });
    this.termEl = h("div");
    host.append(this.termEl, this.keysEl, this.markerEl, this.pointerEl);
    this.cols = cast.header.width;
    this.rows = cast.header.height;
    this.term = new window.Terminal({
      cols: this.cols, rows: this.rows, disableStdin: true, scrollback: 0, allowProposedApi: true,
      fontFamily: getComputedStyle(document.body).getPropertyValue("--mono"), fontSize: 12,
      theme: { background: DEF_BG, foreground: DEF_FG }, cursorBlink: false,
    });
    this.term.open(this.termEl);
    this.idx = 0;
    this.t = 0;
    this.fit();
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(host);
  }
  /** Pick a font size so the terminal fills the pane width. xterm.js rounds cell sizes to device pixels, so
   * estimate first, then correct from the rendered width. */
  fit(pass = 0) {
    const width = this.host.clientWidth - 24;
    if (width <= 0) return;
    const screen = this.termEl.querySelector(".xterm-screen");
    const cur = this.term.options.fontSize || 12;
    const actual = screen ? screen.getBoundingClientRect().width : 0;
    let fs = actual > 0 && pass > 0 ? (cur * width) / actual : width / (this.cols * measureCharRatio());
    fs = Math.max(4, Math.min(MAX_FONT, Math.floor(fs * 10) / 10));
    if (Math.abs(cur - fs) > 0.05) this.term.options.fontSize = fs;
    if (pass < 3) requestAnimationFrame(() => this.fit(pass + 1));
  }
  reset() {
    this.term.reset();
    this.term.resize(this.cast.header.width, this.cast.header.height);
    this.cols = this.cast.header.width;
    this.idx = 0;
    this.t = 0;
    this.pointerEl.className = "pointer";
    this.fit();
  }
  /** Advance to time t (seconds), writing all output events up to it. */
  advance(t, animate) {
    if (t < this.t) this.reset();
    let out = "";
    const ev = this.cast.events;
    while (this.idx < ev.length && ev[this.idx][0] <= t) {
      const [, code, data] = ev[this.idx++];
      if (code === "o") out += data;
      else if (code === "r") {
        if (out) { this.term.write(out); out = ""; }
        const [c, r] = data.split("x").map(Number);
        this.term.resize(c, r);
        this.cols = c;
        this.fit();
      } else if (code === "i") {
        this.pointer(data, animate);
        const label = animate && keyLabel(data);
        if (label) this.flash(this.keysEl, label);
      }
      else if (code === "m" && animate) this.flash(this.markerEl, "◆ " + data, 1500);
    }
    if (out) this.term.write(out);
    this.t = t;
  }
  /** Move the drawn mouse pointer to the cell of an SGR mouse report; pulse it on button presses. */
  pointer(data, animate) {
    const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data);
    if (!m) return;
    const screen = this.termEl.querySelector(".xterm-screen");
    if (!screen) return;
    const cw = screen.clientWidth / this.term.cols;
    const ch = screen.clientHeight / this.term.rows;
    const el = this.pointerEl;
    el.style.left = `${screen.offsetLeft + (+m[2] - 0.5) * cw}px`;
    el.style.top = `${screen.offsetTop + (+m[3] - 0.5) * ch}px`;
    el.classList.add("on");
    const b = +m[1];
    el.classList.toggle("down", m[4] === "M" && !(b & 32) && b < 64);
    if (animate && m[4] === "M" && !(b & 32)) {
      el.classList.remove("pulse");
      void el.offsetWidth;
      el.classList.add("pulse");
    }
  }
  flash(el, text, ms = 700) {
    el.textContent = text;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("on"), ms);
  }
  dispose() {
    this.ro.disconnect();
    this.term.dispose();
  }
}

async function castOf(e) {
  if (e.cast) return parseCast(e.cast);
  if (e.castUrl) {
    const r = await fetch(e.castUrl);
    if (r.ok) return parseCast(await r.text());
  }
  return null;
}

/** xterm.js is a deferred CDN script; it may not have run yet when a replay is first rendered. */
function xtermReady() {
  if (window.Terminal || document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener("load", resolve, { once: true });
    setTimeout(resolve, 10000);
  });
}

/** Two (or more) players sharing one clock and one set of transport controls. */
function replayPanel(entries, labels) {
  const wrap = h("div");
  const grid = h("div", { class: entries.length > 1 ? "pair" : "" });
  const slider = h("input", { type: "range", min: 0, max: 1000, value: 0 });
  const time = h("span", { class: "time" }, "0.0s");
  const playBtn = h("button", { class: "primary" }, "▶ Play");
  const speedSel = h("select", {}, [0.5, 1, 2, 4].map((s) => h("option", { value: s, selected: s === 1 }, `${s}×`)));
  wrap.append(h("div", { class: "transport" }, playBtn, h("button", { onclick: () => seek(0) }, "↺ Restart"), speedSel, slider, time), grid);

  let players = [];
  let duration = 0;
  let t = 0;
  let playing = false;
  let last = 0;

  (async () => {
    await xtermReady();
    if (!window.Terminal) {
      grid.append(emptyTerm("Replay unavailable: xterm.js did not load."));
      return;
    }
    const casts = await Promise.all(entries.map(castOf));
    entries.forEach((e, i) => {
      const col = h("div", { class: "player" });
      if (labels && labels[i]) col.append(labels[i]);
      const host = h("div", { class: "player-host" });
      col.append(host);
      grid.append(col);
      if (!casts[i]) {
        host.replaceWith(emptyTerm("No recording", status(e).text));
        return;
      }
      players.push(new CastPlayer(host, casts[i]));
      duration = Math.max(duration, casts[i].duration);
    });
    seek(0);
  })();

  function render(animate) {
    for (const p of players) p.advance(t, animate);
    slider.value = duration ? Math.round((t / duration) * 1000) : 0;
    time.textContent = `${t.toFixed(1)}s / ${duration.toFixed(1)}s`;
  }
  function seek(nt) {
    t = Math.max(0, Math.min(duration, nt));
    for (const p of players) p.reset();
    render(false);
  }
  function tick(now) {
    if (!playing || !wrap.isConnected) return (playing = false);
    t += ((now - last) / 1000) * +speedSel.value;
    last = now;
    if (t >= duration) { t = duration; playing = false; playBtn.textContent = "▶ Play"; }
    render(true);
    if (playing) requestAnimationFrame(tick);
  }
  playBtn.onclick = () => {
    if (playing) { playing = false; playBtn.textContent = "▶ Play"; return; }
    if (t >= duration) seek(0);
    playing = true;
    playBtn.textContent = "❚❚ Pause";
    last = performance.now();
    requestAnimationFrame(tick);
  };
  slider.oninput = () => { playing = false; playBtn.textContent = "▶ Play"; seek((slider.value / 1000) * duration); };
  wrap.dispose = () => { playing = false; players.forEach((p) => p.dispose()); };
  return wrap;
}

/* ---------- shared pieces ---------- */
function taskHeader(t, extra) {
  return h("div", { class: "card task-head" },
    h("h2", {}, t.title),
    h("p", {}, t.summary, h("span", { class: "muted" }, `  ·  ${t.size.cols}×${t.size.rows}`)),
    h("details", { class: "spec" }, h("summary", {}, "Show the specification the models were given"), h("pre", {}, t.prompt)),
    extra || null,
  );
}

function checkpointRows(t, left, right, labels) {
  const frag = h("div");
  t.checkpoints.forEach((cp, i) => {
    const marks = mouseMarks(cp.steps || []);
    const side = (e, label) => h("div", {}, label ? label() : null, h("div", { class: "side-chips" }, checksChip(e, cp.name), inputWarningChips(e, cp.name)), snapshotOrPlaceholder(e, cp.name, marks));
    frag.append(h("section", { class: "checkpoint" },
      h("div", { class: "cp-head" },
        h("span", { class: "cp-n" }, `${i + 1}/${t.checkpoints.length}`),
        h("span", { class: "cp-name" }, cp.name),
        cp.note ? h("span", { class: "cp-note" }, cp.note) : null),
      stepsStrip(cp.steps || []),
      h("div", { class: "pair" }, side(left, labels && labels[0]), side(right, labels && labels[1])),
    ));
  });
  return frag;
}

/* ---------- scripted input, shown to judges ---------- */
const MOUSE_STEPS = ["click", "drag", "scroll", "hover"];
const at = (p) => `(${p.x},${p.y})`;

/** Mouse steps of a checkpoint, numbered in order, for drawing on the screenshot. Steps before a resize are dropped:
 * their coordinates refer to the old grid. */
function mouseMarks(steps) {
  let marks = [];
  for (const st of steps) {
    if ("resize" in st) marks = [];
    const kind = MOUSE_STEPS.find((k) => k in st);
    if (kind) marks.push({ kind, ...st[kind] });
  }
  return marks.map((m, i) => ({ ...m, n: i + 1 }));
}

function stepChip(st, n) {
  if ("press" in st) {
    const keys = Array.isArray(st.press) ? st.press : st.press.split(/\s+/).filter(Boolean);
    return keys.map((k) => h("kbd", { class: "step-key" }, k));
  }
  const chip = (text, cls = "") => h("span", { class: `step ${cls}` }, n ? h("b", { class: "mk-n" }, n) : null, text);
  if ("type" in st) return chip(`type “${st.type}”`);
  if ("paste" in st) return chip(`paste “${st.paste.length > 30 ? st.paste.slice(0, 30) + "…" : st.paste}”`);
  if ("wait" in st) return chip(`wait ${st.wait >= 1000 ? st.wait / 1000 + "s" : st.wait + "ms"}`, "muted");
  if ("resize" in st) return chip(`resize to ${st.resize.cols}×${st.resize.rows}`);
  const c = st.click;
  if (c) {
    const what = [c.count === 2 ? "double-click" : c.count === 3 ? "triple-click" : "click", c.button && c.button !== "left" ? `(${c.button})` : ""];
    return chip(`${(c.mods || []).map((m) => m + "+").join("")}${what.join(" ")} at ${at(c)}`, "mouse");
  }
  if (st.drag) return chip(`${(st.drag.mods || []).map((m) => m + "+").join("")}drag ${at(st.drag.from)} → ${at(st.drag.to)}`, "mouse");
  if (st.scroll) return chip(`scroll ${st.scroll.direction === "up" ? "↑" : "↓"}${st.scroll.amount > 1 ? "×" + st.scroll.amount : ""} at ${at(st.scroll)}`, "mouse");
  if (st.hover) return chip(`hover at ${at(st.hover)}`, "mouse");
  return null;
}

function stepsStrip(steps) {
  if (!steps.length) return h("div", { class: "steps" }, h("span", { class: "muted" }, "Right after startup, no input yet"));
  let n = 0;
  return h("div", { class: "steps", title: "Scripted input sent to every app since the previous checkpoint" },
    h("span", { class: "steps-label" }, "Input"),
    steps.map((st) => stepChip(st, MOUSE_STEPS.some((k) => k in st) ? ++n : null)));
}

/** Draw clicks, drags, scrolls and hovers onto the snapshot, in terminal cell units. */
function renderMarks(marks, cols, rows) {
  const layer = h("div", { class: "marks", "aria-hidden": "true" });
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${cols} ${rows}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "mk-svg");
  svg.style.width = `${cols}ch`;
  svg.style.height = `${rows * 1.2}em`;
  const cell = (x, y, cls, extra = {}) => h("span", { class: `mk ${cls}`, style: { left: `${x}ch`, top: `${y * 1.2}em` }, ...extra });
  for (const m of marks) {
    if (m.kind === "drag") {
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", m.from.x + 0.5); line.setAttribute("y1", m.from.y + 0.5);
      line.setAttribute("x2", m.to.x + 0.5); line.setAttribute("y2", m.to.y + 0.5);
      line.setAttribute("vector-effect", "non-scaling-stroke");
      svg.append(line);
      layer.append(cell(m.from.x, m.from.y, "mk-from"), cell(m.to.x, m.to.y, "mk-to"), cell(m.from.x, m.from.y, "mk-label", {}, ));
      layer.lastChild.textContent = m.n;
    } else {
      const cls = { click: `mk-click${m.count > 1 ? " mk-double" : ""}${m.button === "right" ? " mk-right" : ""}`, scroll: "mk-scroll", hover: "mk-hover" }[m.kind];
      layer.append(cell(m.x, m.y, cls, {}));
      if (m.kind === "scroll") layer.lastChild.textContent = m.direction === "up" ? "↑" : "↓";
      layer.append(cell(m.x, m.y, "mk-label"));
      layer.lastChild.textContent = m.n;
    }
  }
  layer.prepend(svg);
  return layer;
}

/** Pass count of the task's expected-screen checks, overall or for one checkpoint. */
function checkScore(e, cpName) {
  const cs = (e.checks || []).filter((c) => !cpName || c.checkpoint === cpName);
  const t = task(e.task);
  const total = cpName ? cs.length : (t && t.checkCount) || cs.length;
  return { passed: cs.filter((c) => c.pass).length, total, list: cs };
}

/** "✓ 3/3 checks" chip that expands into the individual checks. Objective, so safe in blind voting. */
function checksChip(e, cpName) {
  const cp = task(e.task).checkpoints.find((c) => c.name === cpName);
  const declared = cp && cp.checks;
  const { passed, total, list } = checkScore(e, cpName);
  if (!declared && !total) return null;
  if (!list.length) return h("span", { class: "chip bad" }, "✗ checks not run");
  const ok = passed === total;
  return h("details", { class: "checks" },
    h("summary", { class: `chip ${ok ? "good" : "bad"}` }, `${ok ? "✓" : "✗"} ${passed}/${total} checks`),
    h("ul", {}, list.map((c) => h("li", { class: c.pass ? "ok" : "fail" }, c.pass ? "✓ " : "✗ ", c.label, c.pass || !c.detail ? null : h("span", { class: "muted" }, ` (${c.detail})`)))));
}

function inputWarningChips(e, cpName) {
  const snap = (e.snapshots || []).find((s) => s.name === cpName);
  const w = snap && snap.inputWarnings;
  if (!w || !w.length) return null;
  const mouse = w.every((x) => /click|drag|scroll|hover/.test(x));
  return h("span", { class: "side-warn" }, h("span", { class: "chip warn", title: w.join("\n") }, mouse ? "⚠ mouse input ignored: the app never enabled mouse reporting" : `⚠ ${w.length} input(s) not delivered`));
}

function segmented(options, value, onChange) {
  const seg = h("div", { class: "seg", role: "group" });
  for (const [v, label] of options) {
    seg.append(h("button", { class: v === value ? "on" : "", "aria-pressed": v === value ? "true" : "false", onclick: () => onChange(v) }, label));
  }
  return seg;
}

function emptyState(msg) {
  return h("div", { class: "card empty-state", html: msg });
}

/* ---------- Arena (blind pairwise judging) ---------- */
const arena = { pair: null, revealed: null, mode: "snapshots", history: [] };

function pairKey(a, b) {
  return [a, b].sort().join(" | ");
}

function candidatePairs(taskFilter, pairing, includeBroken) {
  const pairs = [];
  for (const t of S.data.tasks) {
    if (taskFilter !== "all" && t.id !== taskFilter) continue;
    const es = entriesFor(t.id).filter((e) => includeBroken || !status(e).broken);
    for (let i = 0; i < es.length; i++) {
      for (let j = i + 1; j < es.length; j++) {
        const a = es[i], b = es[j];
        if (pairing === "models" && (a.stack !== b.stack || a.model === b.model)) continue;
        if (pairing === "stacks" && (a.model !== b.model || a.stack === b.stack)) continue;
        if (status(a).broken && status(b).broken) continue; // nothing to judge
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

function pickPair() {
  const p = prefs();
  const pairs = candidatePairs(p.arenaTask || "all", p.arenaPairing || "models", p.arenaBroken !== false);
  if (!pairs.length) return null;
  const me = judgeName();
  const counts = new Map();
  const mine = new Set();
  for (const j of S.judgments) {
    const k = pairKey(j.a, j.b);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (j.judge === me) mine.add(k);
  }
  // Prefer pairs this judge hasn't seen, then pairs with the fewest judgments overall.
  const score = ([a, b]) => (mine.has(pairKey(a.id, b.id)) ? 1e6 : 0) + (counts.get(pairKey(a.id, b.id)) || 0);
  const best = Math.min(...pairs.map(score));
  const pool = pairs.filter((pr) => score(pr) === best);
  const [x, y] = pool[Math.floor(Math.random() * pool.length)];
  return Math.random() < 0.5 ? [x, y] : [y, x];
}

function viewArena(root) {
  const p = prefs();
  const taskSel = h("select", { onchange: (e) => { setPref("arenaTask", e.target.value); arena.pair = null; route(); } },
    h("option", { value: "all" }, "All tasks"),
    S.data.tasks.map((t) => h("option", { value: t.id, selected: p.arenaTask === t.id }, t.title)));
  const pairing = segmented(
    [["models", "Compare models (same stack)"], ["stacks", "Compare stacks (same model)"], ["any", "Any pair"]],
    p.arenaPairing || "models",
    (v) => { setPref("arenaPairing", v); arena.pair = null; route(); },
  );
  const broken = h("input", { type: "checkbox", checked: p.arenaBroken !== false, onchange: (e) => { setPref("arenaBroken", e.target.checked); arena.pair = null; route(); } });
  root.append(h("div", { class: "toolbar" },
    h("label", {}, "Task", taskSel), pairing,
    h("label", { title: "A build that fails or never starts loses to one that works. Excluding them hides those wins." }, broken, "Include broken builds"),
    h("span", { class: "spacer" }),
    h("span", { class: "muted" }, `${plural(S.judgments.filter((j) => j.judge === judgeName()).length, "vote")} by you · ${S.judgments.length} total`)));

  if (!arena.pair) { arena.pair = pickPair(); arena.revealed = null; }
  if (!arena.pair) {
    root.append(emptyState(S.data.entries.length
      ? "No pairs to judge with these filters. Try <b>Any pair</b>, another task, or generate results for more models."
      : "No results yet. Run <code>tuibench generate</code> and <code>tuibench capture</code>, then <code>tuibench report</code>."));
    return;
  }
  const [A, B] = arena.pair;
  const t = task(A.task);
  const revealed = arena.revealed;
  const label = (which, e) => () => h("div", { class: "side-label" },
    h("span", { class: `badge ${which}` }, which.toUpperCase()),
    revealed ? h("strong", {}, entryLabel(e)) : null,
    statusChips(e));

  root.append(taskHeader(t, h("div", { class: "toolbar", style: { margin: "12px 0 0" } },
    segmented([["snapshots", "Snapshots"], ["replay", "Replay recordings"]], arena.mode, (v) => { arena.mode = v; route(); }))));

  if (arena.mode === "replay") {
    root.append(replayPanel([A, B], [label("a", A)(), label("b", B)()]));
  } else {
    root.append(checkpointRows(t, A, B, [label("a", A), label("b", B)]));
  }

  const bar = h("div", { class: "votebar" });
  if (!revealed) {
    const notes = h("input", { placeholder: "Notes (optional) — why?", id: "vote-notes" });
    const vote = (winner) => async () => {
      const j = { id: uuid(), ts: new Date().toISOString(), judge: judgeName(), task: A.task, a: A.id, b: B.id, winner, blind: true, notes: notes.value.trim() || undefined };
      await addJudgment(j);
      arena.history.push(j.id);
      arena.revealed = j;
      route();
    };
    bar.append(
      h("button", { class: "vote-a", onclick: vote("a") }, h("span", { class: "badge a" }, "A"), "is better", h("kbd", {}, "1")),
      h("button", { onclick: vote("tie") }, "Tie", h("kbd", {}, "2")),
      h("button", { class: "vote-b", onclick: vote("b") }, h("span", { class: "badge b" }, "B"), "is better", h("kbd", {}, "3")),
      h("button", { onclick: vote("both_bad") }, "Both bad", h("kbd", {}, "4")),
      h("div", { class: "notes" }, notes),
      h("button", { onclick: () => { arena.pair = null; route(); } }, "Skip", h("kbd", {}, "s")),
    );
    bar.dataset.keys = "vote";
    bar._vote = vote;
  } else {
    const verdict = { a: "You picked A", b: "You picked B", tie: "You called it a tie", both_bad: "You marked both as bad" }[revealed.winner];
    bar.append(h("div", { class: "reveal" },
      h("span", {}, verdict, ":"),
      h("span", {}, h("span", { class: "badge a" }, "A"), " ", h("strong", {}, entryLabel(A))),
      h("span", {}, h("span", { class: "badge b" }, "B"), " ", h("strong", {}, entryLabel(B)))),
      h("span", { class: "spacer", style: { flex: 1 } }),
      h("button", { onclick: async () => { await deleteJudgment(revealed.id); arena.revealed = null; route(); } }, "Undo vote", h("kbd", {}, "u")),
      h("button", { class: "primary", onclick: () => { arena.pair = null; route(); window.scrollTo(0, 0); } }, "Next pair →", h("kbd", {}, "n")));
  }
  root.append(bar);
}

document.addEventListener("keydown", (ev) => {
  if (currentView() !== "arena" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
  const bar = $(".votebar");
  if (!bar) return;
  if (!arena.revealed && bar._vote) {
    const map = { 1: "a", 2: "tie", 3: "b", 4: "both_bad" };
    if (map[ev.key]) { ev.preventDefault(); bar._vote(map[ev.key])(); }
    else if (ev.key === "s") { arena.pair = null; route(); }
  } else if (arena.revealed) {
    if (ev.key === "n" || ev.key === "Enter") { arena.pair = null; route(); window.scrollTo(0, 0); }
    else if (ev.key === "u") { deleteJudgment(arena.revealed.id).then(() => { arena.revealed = null; route(); }); }
  }
});

/* ---------- Compare (named side by side) ---------- */
function viewCompare(root, q) {
  const tasksWithEntries = S.data.tasks.filter((t) => entriesFor(t.id).length);
  if (!tasksWithEntries.length) return root.append(emptyState("No results yet."));
  const t = task(q.get("task")) && entriesFor(q.get("task")).length ? task(q.get("task")) : tasksWithEntries[0];
  const es = entriesFor(t.id);
  const A = S.entriesById.get(q.get("a")) && S.entriesById.get(q.get("a")).task === t.id ? S.entriesById.get(q.get("a")) : es[0];
  const B = S.entriesById.get(q.get("b")) && S.entriesById.get(q.get("b")).task === t.id ? S.entriesById.get(q.get("b")) : es[1] || es[0];
  const tab = q.get("tab") || "snapshots";
  const go = (patch) => {
    const n = new URLSearchParams({ task: t.id, a: A.id, b: B.id, tab, ...patch });
    navigate("compare?" + n.toString());
  };
  const entrySel = (cur, key) => h("select", { onchange: (e) => go({ [key]: e.target.value }) },
    es.map((e) => h("option", { value: e.id, selected: e.id === cur.id }, entryLabel(e))));

  root.append(h("div", { class: "toolbar" },
    h("label", {}, "Task", h("select", { onchange: (e) => go({ task: e.target.value, a: "", b: "" }) },
      tasksWithEntries.map((x) => h("option", { value: x.id, selected: x.id === t.id }, x.title)))),
    h("label", {}, h("span", { class: "badge a" }, "A"), entrySel(A, "a")),
    h("button", { title: "Swap sides", onclick: () => go({ a: B.id, b: A.id }) }, "⇄"),
    h("label", {}, h("span", { class: "badge b" }, "B"), entrySel(B, "b"))));

  root.append(taskHeader(t, h("div", { class: "toolbar", style: { margin: "12px 0 0" } },
    segmented([["snapshots", "Snapshots"], ["replay", "Replay"], ["code", "Code"], ["details", "Run details"]], tab, (v) => go({ tab: v })))));

  const label = (which, e) => () => h("div", { class: "side-label" }, h("span", { class: `badge ${which}` }, which.toUpperCase()), h("strong", {}, entryLabel(e)), statusChips(e));
  if (tab === "snapshots") root.append(checkpointRows(t, A, B, [label("a", A), label("b", B)]));
  else if (tab === "replay") root.append(replayPanel([A, B], [label("a", A)(), label("b", B)()]));
  else if (tab === "code") root.append(h("div", { class: "pair" }, codePane(A, label("a", A)), codePane(B, label("b", B))));
  else root.append(h("div", { class: "pair" }, detailsPane(A, label("a", A)), detailsPane(B, label("b", B))));
}

function codePane(e, label) {
  const files = e.files || [];
  const pre = h("pre");
  const isSrc = (f) => /\.(rs|ts|tsx|js|jsx)$/.test(f.path);
  const first = files.find((f) => /src\/(main\.rs|index\.tsx?)$/.test(f.path)) || files.find(isSrc) || files[0];
  const show = (p) => { const f = files.find((x) => x.path === p); pre.textContent = f ? f.content : ""; };
  const sel = h("select", { onchange: (ev) => show(ev.target.value) },
    files.map((f) => h("option", { value: f.path, selected: f === first }, `${f.path}  (${f.content.split("\n").length} lines)`)));
  if (first) show(first.path);
  return h("div", { class: "code-pane" }, label(), files.length ? [sel, pre] : emptyTerm("No source files"));
}

function fmtNum(n) {
  if (n === undefined || n === null) return "—";
  return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : String(n);
}
function fmtDur(ms) {
  if (!ms && ms !== 0) return "—";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function detailsPane(e, label) {
  const m = e.meta, a = m.agent || {}, u = a.usage || {}, c = e.capture || {};
  const rows = [
    ["Model", `${m.modelName}${m.providerModel ? ` (${m.provider}: ${m.providerModel}${m.effort ? `, effort ${m.effort}` : ""})` : ` (${m.provider})`}`],
    ["Stack", stackTitle(e.stack)],
    ["Origin", m.source],
    ...(m.external ? [
      ["Harness", m.external.harness],
      ["Tokens (total)", fmtNum(m.external.totalTokens)],
      ["Tool calls", m.external.toolCalls ?? "—"],
    ] : []),
    ["Agent stop", a.stopReason ? `${a.stopReason}${a.error ? ` — ${a.error}` : ""}` : "—"],
    ["Turns", a.turns ?? "—"],
    ["Tokens (in / out)", u.inputTokens !== undefined ? `${fmtNum(u.inputTokens + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0))} / ${fmtNum(u.outputTokens)}` : "—"],
    ["Builds (failed)", a.builds !== undefined ? `${a.builds} (${a.failedBuilds})` : "—"],
    ["Self-test runs", a.runs ?? "—"],
    ["Wall time", fmtDur(m.durationMs)],
    ["Final build", m.build ? (m.build.ok ? "ok" : "failed") + (m.build.typecheckOk === false ? ", type errors" : "") : "—"],
    ["Source", m.source_stats ? `${m.source_stats.files} files, ${m.source_stats.lines} lines` : "—"],
    ["Spec checks", (() => { const k = checkScore(e); return k.total ? `${k.passed}/${k.total} passed` : "none declared"; })()],
    ["Capture", c.capturedAt ? `${c.snapshotCount} snapshots${c.crashed ? ", crashed" : ""}${c.cleanExit === true ? ", clean exit" : c.cleanExit === false ? ", unclean exit" : ""}` : "not captured"],
  ];
  return h("div", {}, label(),
    h("div", { class: "card section" }, h("table", { class: "data meta-table" }, rows.map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, String(v)))))),
    (a.summary || (m.external && m.external.summary)) ? h("div", { class: "card section" }, h("h3", {}, "Agent's summary"), h("p", { style: { whiteSpace: "pre-wrap", margin: 0 } }, a.summary || m.external.summary)) : null,
    e.buildLog ? h("div", { class: "card section" }, h("h3", {}, "Build log"), h("pre", { class: "log-pre" }, e.buildLog)) : null);
}

/* ---------- Gallery ---------- */
function viewGallery(root, q) {
  const tasksWithEntries = S.data.tasks.filter((t) => entriesFor(t.id).length);
  if (!tasksWithEntries.length) return root.append(emptyState("No results yet."));
  const t = task(q.get("task")) && entriesFor(q.get("task")).length ? task(q.get("task")) : tasksWithEntries[0];
  const cp = t.checkpoints.find((c) => c.name === q.get("cp")) || t.checkpoints[0];
  const stack = q.get("stack") || "all";
  const go = (patch) => navigate("gallery?" + new URLSearchParams({ task: t.id, cp: cp.name, stack, ...patch }));
  root.append(h("div", { class: "toolbar" },
    h("label", {}, "Task", h("select", { onchange: (e) => go({ task: e.target.value, cp: "" }) }, tasksWithEntries.map((x) => h("option", { value: x.id, selected: x.id === t.id }, x.title)))),
    h("label", {}, "Checkpoint", h("select", { onchange: (e) => go({ cp: e.target.value }) }, t.checkpoints.map((c, i) => h("option", { value: c.name, selected: c === cp }, `${i + 1}. ${c.name}`)))),
    segmented([["all", "All stacks"], ...S.data.stacks.map((s) => [s.id, s.title])], stack, (v) => go({ stack: v })),
    cp.note ? h("span", { class: "muted" }, cp.note) : null));
  const grid = h("div", { class: "grid" });
  for (const e of entriesFor(t.id).filter((e) => stack === "all" || e.stack === stack)) {
    grid.append(h("div", { class: "card tile", onclick: () => navigate("compare?" + new URLSearchParams({ task: t.id, a: e.id, b: "" })) },
      h("div", { class: "side-chips" }, checksChip(e, cp.name), inputWarningChips(e, cp.name)),
      snapshotOrPlaceholder(e, cp.name, mouseMarks(cp.steps || [])),
      h("div", { class: "cap" }, h("strong", {}, entryLabel(e)), h("span", {}, statusChips(e)))));
  }
  root.append(grid);
}

/* ---------- Results (objective metrics) ---------- */
function viewResults(root) {
  if (!S.data.entries.length) return root.append(emptyState("No results yet."));
  const groups = new Map();
  for (const e of S.data.entries) {
    const k = `${e.model}\u0000${e.stack}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const rows = [...groups.entries()].map(([k, es]) => {
    const [model, stack] = k.split("\u0000");
    const n = es.length;
    const built = es.filter((e) => e.meta.build && e.meta.build.ok).length;
    const ran = es.filter((e) => !status(e).broken).length;
    const clean = es.filter((e) => e.capture && e.capture.cleanExit === true).length;
    const crashed = es.filter((e) => e.capture && e.capture.crashed).length;
    const scores = es.map((e) => checkScore(e)).filter((k) => k.total);
    const checksPassed = scores.reduce((a, k) => a + k.passed, 0);
    const checksTotal = scores.reduce((a, k) => a + k.total, 0);
    const avg = (f) => { const v = es.map(f).filter((x) => typeof x === "number"); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    return {
      model, stack, n, built, ran, clean, crashed, checksPassed, checksTotal,
      turns: avg((e) => e.meta.agent && e.meta.agent.turns),
      out: avg((e) => e.meta.agent && e.meta.agent.usage && e.meta.agent.usage.outputTokens),
      time: avg((e) => e.meta.durationMs),
      lines: avg((e) => e.meta.source_stats && e.meta.source_stats.lines),
    };
  }).sort((a, b) => b.ran - a.ran || (b.checksTotal ? b.checksPassed / b.checksTotal : 0) - (a.checksTotal ? a.checksPassed / a.checksTotal : 0) || modelName(a.model).localeCompare(modelName(b.model)));
  const pct = (x, n) => `${x}/${n}`;
  root.append(h("div", { class: "card section" },
    h("h3", {}, "Objective results by model and stack"),
    h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("tr", {}, ["Model", "Stack", "Tasks", "Built", "Ran", "Clean exit", "Crashed", "Spec checks", "Avg turns", "Avg out tokens", "Avg time", "Avg lines"].map((x, i) => h("th", { class: i > 1 ? "num" : "" }, x))),
      rows.map((r) => h("tr", {},
        h("td", {}, modelName(r.model)), h("td", {}, stackTitle(r.stack)), h("td", { class: "num" }, r.n),
        h("td", { class: "num" }, pct(r.built, r.n)), h("td", { class: "num" }, pct(r.ran, r.n)), h("td", { class: "num" }, pct(r.clean, r.n)),
        h("td", { class: "num" }, r.crashed),
        h("td", { class: "num", title: "Expected-screen checks passed, over all tasks" }, r.checksTotal ? `${r.checksPassed}/${r.checksTotal} (${Math.round((100 * r.checksPassed) / r.checksTotal)}%)` : "—"), h("td", { class: "num" }, r.turns === null ? "—" : r.turns.toFixed(1)),
        h("td", { class: "num" }, fmtNum(r.out && Math.round(r.out))), h("td", { class: "num" }, fmtDur(r.time)),
        h("td", { class: "num" }, r.lines === null ? "—" : Math.round(r.lines))))))));

  // Matrix: tasks × (model, stack)
  const cols = rows.map((r) => [r.model, r.stack]);
  root.append(h("div", { class: "card section" },
    h("h3", {}, "Status per task"),
    h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("tr", {}, h("th", {}, "Task"), cols.map(([m, s]) => h("th", {}, `${modelName(m)}`, h("br"), h("span", { class: "muted" }, stackTitle(s))))),
      S.data.tasks.map((t) => h("tr", {}, h("td", {}, t.title), cols.map(([m, s]) => {
        const e = S.entriesById.get(`${t.id}/${s}/${m}`);
        if (!e) return h("td", { class: "muted" }, "—");
        const st = status(e);
        const k = checkScore(e);
        const score = k.total ? ` · ${k.passed}/${k.total}` : "";
        const kind = st.kind === "good" && k.total && k.passed < k.total ? "warn" : st.kind;
        return h("td", {}, link("compare?" + new URLSearchParams({ task: t.id, a: e.id, b: "", tab: "details" }), st.text + score, { class: `status-${kind === "good" ? "ok" : kind}` }));
      })))))));
}

/* ---------- Leaderboard ---------- */
function viewLeaderboard(root, q) {
  const by = q.get("by") || "model_stack";
  const taskF = q.get("task") || "all";
  const judgeF = q.get("judge") || "all";
  const go = (patch) => navigate("leaderboard?" + new URLSearchParams({ by, task: taskF, judge: judgeF, ...patch }));
  const judges = [...new Set(S.judgments.map((j) => j.judge))].sort();
  const fileInput = h("input", { type: "file", accept: ".json,.jsonl", style: { display: "none" }, onchange: importJudgments });

  root.append(h("div", { class: "toolbar" },
    segmented([["model_stack", "Model × stack"], ["model", "Model"], ["stack", "Stack"]], by, (v) => go({ by: v })),
    h("label", {}, "Task", h("select", { onchange: (e) => go({ task: e.target.value }) }, h("option", { value: "all" }, "All tasks"), S.data.tasks.map((t) => h("option", { value: t.id, selected: t.id === taskF }, t.title)))),
    h("label", {}, "Judge", h("select", { onchange: (e) => go({ judge: e.target.value }) }, h("option", { value: "all" }, "Everyone"), judges.map((j) => h("option", { value: j, selected: j === judgeF }, j)))),
    h("span", { class: "spacer" }),
    h("button", { onclick: exportJudgments }, "Export judgments"),
    S.standalone ? [h("button", { onclick: () => fileInput.click() }, "Import judgments"), fileInput] : null));

  const js = S.judgments.filter((j) => (taskF === "all" || j.task === taskF) && (judgeF === "all" || j.judge === judgeF) && S.entriesById.has(j.a) && S.entriesById.has(j.b));
  if (!js.length) return root.append(emptyState("No judgments yet. Vote in the <a href=\"#arena\">Arena</a>."));
  const keyOf = (id) => {
    const [, stack, model] = id.split("/");
    return by === "model" ? model : by === "stack" ? stack : `${model}\u0000${stack}`;
  };
  const nameOf = (k) => by === "model" ? modelName(k) : by === "stack" ? stackTitle(k) : `${modelName(k.split("\u0000")[0])} · ${stackTitle(k.split("\u0000")[1])}`;
  const ratings = bradleyTerry(js, keyOf);
  const maxR = Math.max(...ratings.map((r) => r.rating));
  const minR = Math.min(...ratings.map((r) => r.rating));
  root.append(h("div", { class: "card section" },
    h("h3", {}, `Ratings from ${js.length} judgment${js.length === 1 ? "" : "s"}`),
    h("p", { class: "muted", style: { marginTop: 0 } }, "Bradley–Terry strengths on an Elo-like scale (mean 1000; +400 means 10:1 odds of being preferred). Ties and \"both bad\" count as half a win each. With few votes per pair these numbers are noisy."),
    h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("tr", {}, h("th", { class: "num" }, "#"), h("th", {}, "Contestant"), h("th", { class: "num" }, "Rating"), h("th", {}, ""), h("th", { class: "num" }, "Votes"), h("th", { class: "num" }, "Won"), h("th", { class: "num" }, "Tied"), h("th", { class: "num" }, "Lost"), h("th", { class: "num" }, "Both bad"), h("th", { class: "num" }, "Win rate")),
      ratings.map((r, i) => h("tr", {},
        h("td", { class: "num" }, i + 1), h("td", {}, nameOf(r.key)), h("td", { class: "num" }, Math.round(r.rating)),
        h("td", { style: { width: "22%" } }, h("div", { class: "bar", style: { width: `${maxR === minR ? 100 : 8 + (92 * (r.rating - minR)) / (maxR - minR)}%` } })),
        h("td", { class: "num" }, r.games), h("td", { class: "num" }, r.wins), h("td", { class: "num" }, r.ties), h("td", { class: "num" }, r.losses), h("td", { class: "num" }, r.bothBad),
        h("td", { class: "num" }, r.games ? `${Math.round((100 * (r.wins + 0.5 * (r.ties + r.bothBad))) / r.games)}%` : "—")))))));

  root.append(h("div", { class: "card section" },
    h("h3", {}, "Recent judgments"),
    h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("tr", {}, ["When", "Judge", "Task", "A", "B", "Verdict", "Notes", ""].map((x) => h("th", {}, x))),
      [...js].sort((x, y) => (x.ts < y.ts ? 1 : -1)).slice(0, 50).map((j) => {
        const a = S.entriesById.get(j.a), b = S.entriesById.get(j.b);
        const verdict = { a: "A better", b: "B better", tie: "tie", both_bad: "both bad" }[j.winner];
        return h("tr", {},
          h("td", { class: "muted" }, new Date(j.ts).toLocaleString()), h("td", {}, j.judge), h("td", {}, (task(j.task) || { title: j.task }).title),
          h("td", {}, entryLabel(a)), h("td", {}, entryLabel(b)), h("td", {}, verdict), h("td", { class: "muted" }, j.notes || ""),
          h("td", {}, link("compare?" + new URLSearchParams({ task: j.task, a: j.a, b: j.b }), "view")));
      })))));
}

/** Show the judgments as JSON with Copy and Download, since some viewers (e.g. sandboxed frames) block downloads. */
function exportJudgments() {
  const existing = $("#export-panel");
  if (existing) return existing.remove();
  const json = JSON.stringify(S.judgments, null, 2);
  const area = h("textarea", { id: "export-json", readonly: true, rows: 8, style: { width: "100%", fontFamily: "var(--mono)", fontSize: "12px" } });
  area.value = json;
  const copy = h("button", { class: "primary", onclick: () => {
    const done = () => toast(`Copied ${plural(S.judgments.length, "judgment")}.`);
    const fallback = () => { area.focus(); area.select(); toast("Press Ctrl+C / Cmd+C to copy the selected JSON."); };
    try { navigator.clipboard.writeText(json).then(done, fallback); } catch { fallback(); }
  } }, "Copy JSON");
  const download = h("button", { onclick: () => {
    const a = h("a", { href: URL.createObjectURL(new Blob([json], { type: "application/json" })), download: `judgments-${judgeName()}-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
  } }, "Download .json");
  const panel = h("div", { class: "card section", id: "export-panel" },
    h("h3", {}, `Export ${plural(S.judgments.length, "judgment")}`),
    h("p", { class: "muted", style: { marginTop: 0 } }, "Save this as a .json file and add it to the benchmark repository with ", h("code", {}, "tuibench judgments import <file>"), "."),
    area, h("div", { class: "toolbar", style: { margin: "10px 0 0" } }, copy, download));
  $(".toolbar").after(panel);
}

async function importJudgments(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const text = await file.text();
  let list;
  try {
    list = text.trim().startsWith("[") ? JSON.parse(text) : text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((o) => o.judgment || o);
  } catch (e) {
    return toast(`Could not read ${file.name}: expected a JSON array of judgments or a judgments.jsonl file.`);
  }
  const byId = new Map(S.judgments.map((j) => [j.id, j]));
  for (const j of list) if (j && j.id && j.a && j.b && j.winner) byId.set(j.id, j);
  S.judgments = [...byId.values()];
  persistLocal();
  route();
}

/* ---------- routing ---------- */
// The route lives in memory ("compare?task=…"). The URL hash only carries the plain view name (#compare),
// because some hosts (sandboxed artifact frames) pass nothing but a plain #name. "#/view?query" deep links
// are still accepted on load.
function parseHash(hash) {
  return hash.replace(/^#\/?/, "") || "arena";
}
S.route = parseHash(location.hash);
function currentView() {
  return S.route.split("?")[0] || "arena";
}
function navigate(r) {
  S.route = r;
  const view = currentView();
  if (parseHash(location.hash) !== view) {
    try { location.hash = view; } catch {}
  }
  route();
}
function link(r, text, attrs = {}) {
  return h("a", { ...attrs, href: "#" + r.split("?")[0], onclick: (e) => { e.preventDefault(); navigate(r); } }, text);
}
function toast(msg) {
  let el = $("#toast");
  if (!el) document.body.append((el = h("div", { id: "toast", role: "status" })));
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("on"), 4000);
}
function route() {
  const [view, qs] = S.route.split("?");
  const q = new URLSearchParams(qs || "");
  const v = view || "arena";
  for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("active", a.dataset.view === v);
  const root = $("#view");
  const old = [...root.querySelectorAll("*")].filter((el) => el.dispose);
  old.forEach((el) => el.dispose());
  root.replaceChildren();
  const fn = { arena: viewArena, compare: viewCompare, gallery: viewGallery, results: viewResults, leaderboard: viewLeaderboard }[v] || viewArena;
  fn(root, q);
}

(async function init() {
  const marks = $("#show-marks");
  marks.checked = prefs().showMarks !== false;
  document.body.classList.toggle("hide-marks", !marks.checked);
  marks.addEventListener("change", () => { setPref("showMarks", marks.checked); document.body.classList.toggle("hide-marks", !marks.checked); });
  const nameInput = $("#judge-name");
  try { nameInput.value = localStorage.getItem(LS_JUDGE) || ""; } catch {}
  nameInput.addEventListener("change", () => { try { localStorage.setItem(LS_JUDGE, nameInput.value.trim()); } catch {} route(); });
  try {
    await loadData();
  } catch (e) {
    $("#view").replaceChildren(emptyState(`Could not load report data (${e.message}). Open the report with <code>tuibench serve</code>, or build it with <code>tuibench report --standalone</code> to open it from disk.`));
    return;
  }
  window.addEventListener("hashchange", () => {
    const r = parseHash(location.hash);
    if (r.split("?")[0] === currentView() && !r.includes("?")) return; // our own navigate()
    S.route = r;
    route();
  });
  route();
})();
