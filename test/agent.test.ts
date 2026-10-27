import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockLLM, type ScriptedCall } from "./mock-llm.ts";

process.env.TUIBENCH_RESULTS = fs.mkdtempSync(path.join(os.tmpdir(), "tuibench-test-"));
process.env.MOCK_KEY = "test-key";

const { generate } = await import("../src/generate.ts");
const { capture } = await import("../src/capture.ts");
const { Entry } = await import("../src/entry.ts");
const { getStack } = await import("../src/stacks.ts");
const { loadTask } = await import("../src/tasks.ts");

const HELLO = fs.readFileSync(path.join(import.meta.dirname, "../stacks/opentui/template/src/index.ts"), "utf8");

// A short agent session: inspect, write the app, typecheck, run it, then finish.
const script: ScriptedCall[][] = [
  [{ name: "list_files", input: {} }, { name: "read_file", input: { path: "data/todos.json", limit: 3 } }],
  [{ name: "write_file", input: { path: "src/index.ts", content: HELLO.replace("Hello, OpenTUI!", "Mock agent app") } }],
  [{ name: "write_file", input: { path: "../escape.txt", content: "nope" } }, { name: "edit_file", input: { path: "src/index.ts", old_string: "does-not-exist", new_string: "x" } }],
  [{ name: "build", input: {} }],
  [{ name: "run_app", input: { steps: [{ press: "j" }, { snapshot: "after-j" }] } }],
  [{ name: "finish", input: { summary: "A mock app." } }],
];

for (const provider of ["anthropic", "openai"] as const) {
  test(`${provider} agent loop drives tools and produces a capturable entry`, { timeout: 180_000 }, async () => {
    const mock = await startMockLLM(script);
    try {
      const model =
        provider === "anthropic"
          ? { id: "mock-a", displayName: "Mock A", provider, model: "claude-opus-5-5", baseURL: mock.url, apiKeyEnv: "MOCK_KEY", effort: "high" as const }
          : { id: "mock-o", displayName: "Mock O", provider, model: "mock-model", baseURL: mock.url, apiKeyEnv: "MOCK_KEY" };
      const task = loadTask("todo-app");
      const meta = await generate(task, getStack("opentui"), model);
      assert.ok(meta);
      assert.equal(meta.agent?.stopReason, "finished");
      assert.equal(meta.agent?.turns, 6);
      assert.equal(meta.agent?.summary, "A mock app.");
      assert.equal(meta.build?.ok, true);
      assert.equal(meta.agent?.usage.outputTokens, 6 * 42);
      assert.equal(mock.requests.length, 6);

      const entry = new Entry("todo-app", "opentui", model.id);
      assert.match(fs.readFileSync(path.join(entry.workspace, "src/index.ts"), "utf8"), /Mock agent app/);
      assert.ok(!fs.existsSync(path.join(entry.dir, "escape.txt")), "write outside the workspace must be refused");

      // Tool results the model saw: errors are flagged, run_app returns a screenshot.
      const transcript = fs.readFileSync(entry.transcriptFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const results = transcript.filter((e) => e.type === "tool_result");
      assert.equal(results.find((r) => r.name === "write_file" && r.isError)?.output.includes("escapes the workspace"), true);
      assert.equal(results.find((r) => r.name === "edit_file")?.isError, true);
      assert.match(results.find((r) => r.name === "build").output, /^BUILD OK/);
      assert.match(results.find((r) => r.name === "run_app").output, /Mock agent app/);

      if (provider === "anthropic") {
        const first = mock.requests[0].body;
        assert.equal(first.model, "claude-opus-5-5");
        assert.deepEqual(first.output_config, { effort: "high" });
        assert.deepEqual(first.cache_control, { type: "ephemeral" });
        assert.equal(first.stream, true);
        // History is append-only: request n+1 starts with all of request n's messages.
        assert.deepEqual(mock.requests[2].body.messages.slice(0, 3), mock.requests[1].body.messages);
        const last = mock.requests[5].body.messages.at(-1);
        assert.equal(last.role, "user");
        assert.equal(last.content[0].type, "tool_result");
      } else {
        const msgs = mock.requests[5].body.messages;
        assert.equal(msgs[0].role, "system");
        assert.equal(msgs.at(-1).role, "tool");
      }

      const cap = await capture(entry);
      assert.equal(cap.started, true);
      assert.equal(cap.cleanExit, true);
      assert.equal(cap.snapshotCount, task.scenario.filter((s) => "snapshot" in s).length);
    } finally {
      await mock.close();
    }
  });
}
