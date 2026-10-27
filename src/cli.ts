import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import YAML from "yaml";
import { z } from "zod";
import { capture, findEntries } from "./capture.ts";
import { Entry } from "./entry.ts";
import { generate, importEntry, prepareWorkspace } from "./generate.ts";
import { bradleyTerry } from "./judge/ratings.ts";
import { judgmentsFile, readJudgments } from "./judge/store.ts";
import { loadModels, modelsFile } from "./models.ts";
import { ROOT, resultsDir } from "./paths.ts";
import { buildReport } from "./report/build.ts";
import { serve } from "./report/server.ts";
import { STACKS, getStack } from "./stacks.ts";
import { listTasks, loadTask } from "./tasks.ts";
import { runScenario, Step } from "./terminal/scenario.ts";
import { previewApp } from "./preview.ts";
import { snapshotToText, type Snapshot } from "./terminal/snapshot.ts";
import { pool, readJson } from "./util.ts";

const list = (v: string, prev: string[] = []) => [...prev, ...v.split(",").map((s) => s.trim()).filter(Boolean)];
const log = (s: string) => console.log(s);

const program = new Command()
  .name("tuibench")
  .description("Benchmark LLMs at building terminal UIs (Rust + ratatui, TypeScript + OpenTUI) with side-by-side human judging");

program
  .command("list")
  .description("List tasks, stacks and configured models")
  .action(() => {
    log("Tasks:");
    for (const t of listTasks()) log(`  ${t.id.padEnd(20)} ${t.title} — ${t.summary}`);
    log("\nStacks:");
    for (const s of Object.values(STACKS)) log(`  ${s.id.padEnd(20)} ${s.title}`);
    log(`\nModels (${path.relative(process.cwd(), modelsFile()) || modelsFile()}):`);
    try {
      for (const m of Object.values(loadModels())) log(`  ${m.id.padEnd(20)} ${m.provider}${"model" in m ? `: ${m.model}` : ""}`);
    } catch (e) {
      log(`  ${(e as Error).message}`);
    }
  });

program
  .command("generate")
  .description("Have models build apps for tasks × stacks, then capture them")
  .option("-t, --task <ids>", "task ids (comma separated or repeated); default all", list)
  .option("-s, --stack <ids>", "stack ids; default all", list)
  .option("-m, --model <ids>", "model ids from models.yaml; default all", list)
  .option("-j, --jobs <n>", "parallel generations", "2")
  .option("-f, --force", "regenerate entries that already exist")
  .option("--no-capture", "skip capturing after generation")
  .action(async (o) => {
    const tasks = ((o.task as string[] | undefined) ?? listTasks().map((t) => t.id)).map(loadTask);
    const stacks = ((o.stack as string[] | undefined) ?? Object.keys(STACKS)).map(getStack);
    const all = loadModels();
    const models = ((o.model as string[] | undefined) ?? Object.keys(all)).map((id) => {
      if (!all[id]) throw new Error(`Unknown model "${id}" (not in ${modelsFile()})`);
      return all[id]!;
    });
    const jobs = tasks.flatMap((t) => stacks.flatMap((s) => models.map((m) => ({ t, s, m }))));
    log(`${jobs.length} generation job(s): ${tasks.length} task(s) × ${stacks.length} stack(s) × ${models.length} model(s)`);
    await pool(jobs, +o.jobs, async ({ t, s, m }) => {
      const meta = await generate(t, s, m, { force: o.force, log });
      if (meta && o.capture) await capture(new Entry(t.id, s.id, m.id), log);
    });
    log("Done. Next: tuibench serve");
  });

program
  .command("capture")
  .description("(Re)build every result and replay its task scenario to produce snapshots and recordings")
  .option("-t, --task <ids>", "filter tasks", list)
  .option("-s, --stack <ids>", "filter stacks", list)
  .option("-m, --model <ids>", "filter models", list)
  .option("-j, --jobs <n>", "parallel captures (keep low: timing affects animations)", "2")
  .action(async (o) => {
    const entries = findEntries(resultsDir(), { tasks: o.task, stacks: o.stack, models: o.model });
    log(`Capturing ${entries.length} result(s)`);
    await pool(entries, +o.jobs, async (e) => void (await capture(e, log)));
  });

program
  .command("import <dir>")
  .description("Import an app built elsewhere (another agent, a human baseline) as a result entry, then capture it")
  .requiredOption("-t, --task <id>", "task id")
  .requiredOption("-s, --stack <id>", "stack id")
  .requiredOption("-m, --model <label>", "label for the entry, e.g. claude-code or human")
  .option("--name <name>", "display name")
  .action(async (dir, o) => {
    const meta = await importEntry(loadTask(o.task), getStack(o.stack), o.model, path.resolve(dir), o.name);
    log(`Imported ${o.task}/${o.stack}/${o.model} (build ${meta.build?.ok ? "ok" : "FAILED"})`);
    await capture(new Entry(o.task, o.stack, o.model), log);
  });

program
  .command("show <task> <stack> <model>")
  .description("Print a result's captured snapshots as text")
  .action((t, s, m) => {
    const e = new Entry(t, s, m);
    const snaps = readJson<Snapshot[]>(path.join(e.captureDir, "snapshots.json"));
    if (!snaps) throw new Error(`No capture for ${e.id}`);
    for (const snap of snaps) log(`\n[${snap.name}] at ${snap.at}ms\n${snapshotToText(snap)}`);
    log(JSON.stringify(e.capture(), null, 2));
  });

program
  .command("preview <dir>")
  .description("Build the app in <dir>, run it with scripted input and print plain-text screenshots (for agents self-testing)")
  .requiredOption("-t, --task <id>", "task id (sets terminal size and data fixtures)")
  .requiredOption("-s, --stack <id>", "stack id")
  .option("--steps <yaml>", 'steps as a YAML/JSON list, e.g. \'[{press: "j j"}, {snapshot: x}]\'', "[]")
  .option("--cols <n>", "terminal columns (default: the task's)")
  .option("--rows <n>", "terminal rows (default: the task's)")
  .action(async (dir, o) => {
    const stack = getStack(o.stack);
    const task = loadTask(o.task);
    const parsed = z.array(Step).safeParse(YAML.parse(o.steps));
    if (!parsed.success) throw new Error(`Invalid --steps:\n${z.prettifyError(parsed.error)}`);
    const ws = path.resolve(dir);
    const b = await stack.check(ws);
    if (!b.ok) {
      log(`BUILD FAILED\n\n${b.output}`);
      process.exitCode = 1;
      return;
    }
    if (b.typecheckOk === false) log(`TYPECHECK FAILED (the app still runs)\n\n${b.output}\n`);
    log(await previewApp(stack, task, ws, parsed.data, { cols: o.cols && +o.cols, rows: o.rows && +o.rows }));
  });

program
  .command("report")
  .description("Build the side-by-side report")
  .option("-o, --out <dir>", "output directory", path.join(ROOT, "report"))
  .option("--standalone", "single self-contained HTML file (data, recordings and judgments inlined) that opens from disk")
  .action((o) => {
    const file = buildReport({ outDir: path.resolve(o.out), standalone: o.standalone });
    log(`Wrote ${file}${o.standalone ? "" : "\nServe it with: tuibench serve (judgments are saved to " + path.relative(process.cwd(), judgmentsFile()) + ")"}`);
  });

program
  .command("serve")
  .description("Build the report and serve it locally; votes are saved to judgments/judgments.jsonl")
  .option("-p, --port <n>", "port", "4173")
  .option("--host <host>", "interface to bind (use 0.0.0.0 to let others on your network judge)", "127.0.0.1")
  .option("-o, --out <dir>", "report directory", path.join(ROOT, "report"))
  .action((o) => {
    const out = path.resolve(o.out);
    buildReport({ outDir: out });
    serve(out, +o.port, o.host);
    log(`Terminal UI Bench report: http://${o.host === "0.0.0.0" ? "localhost" : o.host}:${o.port}/`);
  });

program
  .command("leaderboard")
  .description("Print ratings computed from human judgments")
  .option("--by <what>", "model | stack | model_stack", "model_stack")
  .option("-t, --task <id>", "only this task")
  .action((o) => {
    const js = readJudgments().filter((j) => !o.task || j.task === o.task);
    if (!js.length) return log("No judgments yet.");
    const keyOf = (id: string) => {
      const [, stack, model] = id.split("/");
      return o.by === "model" ? model! : o.by === "stack" ? stack! : `${model} · ${stack}`;
    };
    log(`${js.length} judgments\n`);
    log(`${"#".padStart(3)}  ${"contestant".padEnd(36)} ${"rating".padStart(7)} ${"votes".padStart(6)}   W-T-L (both bad)`);
    bradleyTerry(js, keyOf).forEach((r, i) =>
      log(`${String(i + 1).padStart(3)}  ${r.key.padEnd(36)} ${Math.round(r.rating).toString().padStart(7)} ${String(r.games).padStart(6)}   ${r.wins}-${r.ties}-${r.losses} (${r.bothBad})`),
    );
  });

program
  .command("doctor")
  .description("Check the toolchains: build each stack's template and run it in the harness")
  .action(async () => {
    for (const stack of Object.values(STACKS)) {
      const task = listTasks()[0]!;
      const entry = new Entry("_doctor", stack.id, "template");
      prepareWorkspace(entry, stack, task);
      const b = await stack.check(entry.workspace);
      log(`${stack.title}: build ${b.ok ? "ok" : "FAILED"}${b.typecheckOk === false ? " (typecheck failed)" : ""} in ${(b.durationMs / 1000).toFixed(1)}s`);
      if (!b.ok) {
        log(b.output);
        continue;
      }
      const r = await runScenario({ ...stack.runCommand(entry.workspace), cwd: entry.workspace, cols: 60, rows: 10 }, [
        { snapshot: "start" },
        { press: "q" },
        { expectExit: 3000 },
      ]);
      log(snapshotToText(r.snapshots[0]!));
      log(`  started: ${r.started}, clean exit: ${r.cleanExit}${r.error ? `, error: ${r.error}` : ""}`);
    }
    fs.rmSync(path.join(resultsDir(), "_doctor"), { recursive: true, force: true });
  });

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
