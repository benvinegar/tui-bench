import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeKey, splitKeys } from "../src/terminal/keys.ts";
import { bradleyTerry, type Judgment } from "../src/judge/ratings.ts";
import { listTasks } from "../src/tasks.ts";
import { confine } from "../src/util.ts";

test("key encoding", () => {
  assert.equal(encodeKey("j"), "j");
  assert.equal(encodeKey("enter"), "\r");
  assert.equal(encodeKey("ctrl+c"), "\x03");
  assert.equal(encodeKey("ctrl+d"), "\x04");
  assert.equal(encodeKey("alt+x"), "\x1bx");
  assert.equal(encodeKey("up"), "\x1b[A");
  assert.equal(encodeKey("up", true), "\x1bOA");
  assert.equal(encodeKey("shift+tab"), "\x1b[Z");
  assert.throws(() => encodeKey("hyperjump"));
  assert.deepEqual(splitKeys("j  j enter"), ["j", "j", "enter"]);
});

test("workspace confinement", () => {
  assert.equal(confine("/w", "src/a.rs"), "/w/src/a.rs");
  assert.throws(() => confine("/w", "../x"));
  assert.throws(() => confine("/w", "/etc/passwd"));
});

test("every task loads and scenarios only use known keys", () => {
  const tasks = listTasks();
  assert.ok(tasks.length >= 6);
  for (const t of tasks) {
    const names = t.scenario.flatMap((s) => ("snapshot" in s ? [s.snapshot] : []));
    assert.equal(new Set(names).size, names.length, `${t.id}: duplicate snapshot names`);
    assert.ok(t.scenario.some((s) => "expectExit" in s), `${t.id}: scenario should check that the app quits`);
    for (const s of t.scenario) if ("press" in s) for (const k of splitKeys(s.press)) encodeKey(k);
  }
});

test("bradley-terry ratings", () => {
  const j = (a: string, b: string, winner: Judgment["winner"]): Judgment => ({ id: Math.random() + "", ts: "", judge: "x", task: "t", a: `t/s/${a}`, b: `t/s/${b}`, winner, blind: true });
  const r = bradleyTerry([j("m1", "m2", "a"), j("m1", "m2", "a"), j("m2", "m3", "a"), j("m1", "m3", "tie")], (id) => id.split("/")[2]!);
  assert.deepEqual(r.map((x) => x.key), ["m1", "m2", "m3"]);
  assert.ok(Math.abs(r.reduce((s, x) => s + x.rating, 0) / r.length - 1000) < 1e-6);
  // Same contestant on both sides (e.g. rating by model across stacks) is ignored.
  assert.equal(bradleyTerry([j("m1", "m1", "a")], (id) => id.split("/")[2]!).length, 0);
});
