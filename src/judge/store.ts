import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../paths.ts";
import type { Judgment } from "./ratings.ts";

export function judgmentsFile(): string {
  return path.resolve(process.env.TUIBENCH_JUDGMENTS ?? path.join(ROOT, "judgments", "judgments.jsonl"));
}

type Op = { op: "add"; judgment: Judgment } | { op: "del"; id: string };

/** Judgments are an append-only log of add/delete operations, so concurrent judges never clobber each other. */
export function readJudgments(file = judgmentsFile()): Judgment[] {
  if (!fs.existsSync(file)) return [];
  const byId = new Map<string, Judgment>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const op = JSON.parse(line) as Op;
      if (op.op === "add") byId.set(op.judgment.id, op.judgment);
      else if (op.op === "del") byId.delete(op.id);
    } catch {}
  }
  return [...byId.values()];
}

export function appendOp(op: Op, file = judgmentsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(op) + "\n");
}

export function isJudgment(x: unknown): x is Judgment {
  const j = x as Judgment;
  return (
    !!j &&
    typeof j.id === "string" &&
    typeof j.task === "string" &&
    typeof j.a === "string" &&
    typeof j.b === "string" &&
    ["a", "b", "tie", "both_bad"].includes(j.winner)
  );
}
