import { test } from "node:test";
import assert from "node:assert/strict";
import { check, evaluate, type Expectation } from "../src/expect.ts";
import type { Snapshot } from "../src/terminal/snapshot.ts";

// A 12x3 screen: "┌─ hi 👍 ok" with a wide emoji (two cells), a list, and a status line.
const snap: Snapshot = {
  name: "s",
  at: 0,
  cols: 12,
  rows: 3,
  cursor: { x: 0, y: 0, visible: false },
  altScreen: true,
  lines: [
    [{ t: "┌─ hi " }, { t: "👍", w: 1 }, { t: " ok" }],
    [{ t: "b", fg: "#ff0000" }, { t: " a c" }],
    [{ t: "Ln 3, Col 9" }],
  ],
  text: [],
};
const ok = (e: Expectation) => check(e, snap).pass;

test("cell and text expectations use cell coordinates, counting wide glyphs as two cells", () => {
  assert.ok(ok({ at: { x: 0, y: 0 }, oneOf: "┌╭" }));
  assert.ok(ok({ at: { x: 3, y: 0 }, text: "hi" }));
  assert.ok(ok({ at: { x: 9, y: 0 }, text: "ok" }), "text after the emoji starts at cell 9");
  assert.ok(ok({ at: { x: 3, y: 0 }, notOneOf: "x" }));
  assert.ok(!ok({ at: { x: 0, y: 0 }, oneOf: "╭" }));
});

test("region, case and ordering expectations", () => {
  assert.ok(ok({ contains: "col 9", in: { rows: [-1, -1] } }), "case-insensitive by default, negative rows count from the end");
  assert.ok(!ok({ contains: "col 9", caseSensitive: true }));
  assert.ok(!ok({ contains: "hi", in: { rows: [1, 2] } }));
  assert.ok(ok({ notContains: "zzz" }));
  assert.ok(ok({ matches: "Ln \\d+, Col \\d+" }));
  assert.ok(ok({ inOrder: ["hi", "ok", "c"] }), "reading order across and within rows");
  assert.ok(!ok({ inOrder: ["ok", "hi"] }));
  assert.ok(!ok({ inOrder: ["hi", "missing"] }));
});

test("evaluate fails every check of a checkpoint whose screen was never captured", () => {
  const results = evaluate(
    [
      { snapshot: "s", expect: [{ contains: "hi" }, { contains: "nope", label: "custom label" }] },
      { snapshot: "later", expect: [{ contains: "x" }] },
    ],
    [snap],
  );
  assert.deepEqual(results.map((r) => [r.checkpoint, r.pass]), [["s", true], ["s", false], ["later", false]]);
  assert.equal(results[1]!.label, "custom label");
  assert.equal(results[2]!.detail, "no screen at this checkpoint");
});
