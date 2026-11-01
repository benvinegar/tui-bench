import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { findEntries } from "../capture.ts";
import { evaluate } from "../expect.ts";
import { readJudgments } from "../judge/store.ts";
import { bradleyTerry } from "../judge/ratings.ts";
import { resultsDir } from "../paths.ts";
import { STACKS } from "../stacks.ts";
import { listTasks } from "../tasks.ts";
import type { Step } from "../terminal/scenario.ts";
import type { Snapshot } from "../terminal/snapshot.ts";
import { listFiles, readJson } from "../util.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MAX_SOURCE_BYTES = 400_000;

export interface ReportOptions {
  outDir: string;
  /** Inline everything (data, recordings, judgments) into a single index.html that works from file://. */
  standalone?: boolean;
}

function sourceFiles(workspace: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  let total = 0;
  const files = listFiles(workspace).filter(
    (f) => !f.startsWith("data/") && !/(^|\/)(Cargo\.lock|bun\.lockb?|package-lock\.json)$/.test(f),
  );
  for (const f of files) {
    const abs = path.join(workspace, f);
    const size = fs.statSync(abs).size;
    if (size > 200_000 || total + size > MAX_SOURCE_BYTES) {
      out.push({ path: f, content: `(${size} bytes, omitted)` });
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) continue; // binary
    total += size;
    out.push({ path: f, content: buf.toString("utf8") });
  }
  return out;
}

export function buildReportData(opts: { inlineCasts: boolean; castDir?: string }) {
  const tasks = listTasks();
  const entries = findEntries(resultsDir());
  const models = new Map<string, string>();
  const data = {
    generatedAt: new Date().toISOString(),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary,
      prompt: t.prompt,
      size: t.size,
      tags: t.tags,
      checkpoints: checkpointsOf(t.scenario),
      checkCount: t.scenario.reduce((n, s) => n + ("expect" in s && s.expect ? s.expect.length : 0), 0),
    })),
    stacks: Object.values(STACKS).map((s) => ({ id: s.id, title: s.title })),
    models: [] as { id: string; name: string }[],
    entries: [] as unknown[],
  };

  for (const e of entries) {
    const meta = e.meta()!;
    models.set(meta.model, meta.modelName);
    const cap = e.capture();
    const snapshots = (readJson<Snapshot[]>(path.join(e.captureDir, "snapshots.json")) ?? []).map(({ text: _t, ...s }) => s);
    const castPath = path.join(e.captureDir, "recording.cast");
    let cast: string | null = null;
    let castUrl: string | null = null;
    if (fs.existsSync(castPath)) {
      if (opts.inlineCasts) cast = fs.readFileSync(castPath, "utf8");
      else if (opts.castDir) {
        const name = `${e.task}__${e.stack}__${e.model}.cast`;
        fs.copyFileSync(castPath, path.join(opts.castDir, name));
        castUrl = `casts/${name}`;
      }
    }
    const buildLog = [path.join(e.captureDir, "build.log"), path.join(e.dir, "build.log")].find((f) => fs.existsSync(f));
    const task = tasks.find((t) => t.id === e.task);
    const checks = task && cap?.started ? evaluate(task.scenario, readJson<Snapshot[]>(path.join(e.captureDir, "snapshots.json")) ?? []) : [];
    data.entries.push({
      id: e.id,
      checks,
      task: e.task,
      stack: e.stack,
      model: meta.model,
      meta,
      capture: cap,
      snapshots,
      cast,
      castUrl,
      // Logs embed absolute paths, which contain the model id; strip them so blind judging stays blind.
      buildLog: buildLog && (!cap || !cap.started) ? anonymize(fs.readFileSync(buildLog, "utf8"), e.workspace, e.dir).slice(-6000) : null,
      files: fs.existsSync(e.workspace) ? sourceFiles(e.workspace) : [],
    });
  }
  data.models = [...models].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  return data;
}

/** Each snapshot step, with the input steps that led to it from the previous snapshot. */
function checkpointsOf(scenario: Step[]) {
  const out: { name: string; note: string; steps: Step[]; checks: number }[] = [];
  let pending: Step[] = [];
  for (const step of scenario) {
    if ("snapshot" in step) {
      out.push({ name: step.snapshot, note: step.note ?? "", steps: pending, checks: step.expect?.length ?? 0 });
      pending = [];
    } else if (!("expectExit" in step)) pending.push(step);
  }
  return out;
}

export function buildReport(opts: ReportOptions): string {
  fs.mkdirSync(opts.outDir, { recursive: true });
  const castDir = path.join(opts.outDir, "casts");
  if (!opts.standalone) {
    fs.rmSync(castDir, { recursive: true, force: true });
    fs.mkdirSync(castDir, { recursive: true });
  }
  const data = buildReportData({ inlineCasts: !!opts.standalone, castDir });

  const css = fs.readFileSync(path.join(HERE, "ui.css"), "utf8");
  const js = fs.readFileSync(path.join(HERE, "ui.js"), "utf8");
  // esbuild (via tsx) may wrap functions with __name(); provide it for the embedded source.
  const ratingsJs = `const __name = (f) => f;\nconst bradleyTerry = ${bradleyTerry.toString()};`;
  const boot = opts.standalone
    ? `window.TUIBENCH = { standalone: true, data: ${safeJson(data)}, judgments: ${safeJson(readJudgments())} };`
    : `window.TUIBENCH = { standalone: false };`;
  let html = fs
    .readFileSync(path.join(HERE, "ui.html"), "utf8")
    .replace("/*__CSS__*/", () => css)
    .replace("/*__BOOT__*/", () => boot)
    .replace("/*__RATINGS__*/", () => ratingsJs)
    .replace("/*__APP__*/", () => js);

  // xterm.js (for replays) comes from node_modules: inlined in standalone mode, copied alongside otherwise.
  const xtermDir = path.dirname(require.resolve("@xterm/xterm/package.json"));
  const xtermJs = fs.readFileSync(path.join(xtermDir, "lib", "xterm.js"), "utf8");
  const xtermCss = fs.readFileSync(path.join(xtermDir, "css", "xterm.css"), "utf8");
  if (opts.standalone) {
    html = html
      .replace("<!--__XTERM_CSS__-->", () => `<style>${xtermCss}</style>`)
      .replace("<!--__XTERM_JS__-->", () => `<script>${xtermJs.replace(/<\/script/gi, "<\\/script")}</script>`);
  } else {
    fs.writeFileSync(path.join(opts.outDir, "xterm.js"), xtermJs);
    fs.writeFileSync(path.join(opts.outDir, "xterm.css"), xtermCss);
    html = html
      .replace("<!--__XTERM_CSS__-->", '<link rel="stylesheet" href="xterm.css">')
      .replace("<!--__XTERM_JS__-->", '<script src="xterm.js" defer></script>');
  }
  fs.writeFileSync(path.join(opts.outDir, "index.html"), html);
  if (!opts.standalone) fs.writeFileSync(path.join(opts.outDir, "data.json"), JSON.stringify(data));
  return path.join(opts.outDir, "index.html");
}

function anonymize(text: string, ...paths: string[]): string {
  for (const p of paths) text = text.split(p).join(path.basename(p) === "workspace" ? "<workspace>" : "<entry>");
  return text;
}

/** JSON that is safe to embed inside a <script> element. */
function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
