// desk-recorder to-do tests: deterministic extraction heuristic + the four
// to-do API endpoints (list, extract-merge, toggle, delete).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/app.ts";
import { extractTodos } from "../src/todos.ts";

describe("extractTodos", () => {
  test("catches imperative sentences", () => {
    expect(extractTodos("Call the dentist tomorrow.")).toEqual(["Call the dentist tomorrow"]);
    expect(extractTodos("Please email the slides to the team.")).toEqual([
      "Email the slides to the team",
    ]);
    expect(extractTodos("Schedule the board review for Monday morning.")).toEqual([
      "Schedule the board review for Monday morning",
    ]);
  });

  test("catches commitment phrases", () => {
    expect(extractTodos("I need to send the budget report by Friday.")).toEqual([
      "Send the budget report by Friday",
    ]);
    expect(extractTodos("Don't forget to buy milk on the way home.")).toEqual([
      "Buy milk on the way home",
    ]);
    expect(extractTodos("Follow up with Sarah about the contract.")).toEqual([
      "Follow up with Sarah about the contract",
    ]);
    expect(extractTodos("Remind me to water the plants tonight.")).toEqual([
      "Water the plants tonight",
    ]);
    expect(extractTodos("Let's review the draft together tomorrow.")).toEqual([
      "Review the draft together tomorrow",
    ]);
    expect(extractTodos("Action item: finalize the vendor list.")).toEqual([
      "Finalize the vendor list",
    ]);
  });

  test("ignores plain narrative", () => {
    expect(extractTodos("We talked about the quarterly numbers for a while.")).toEqual([]);
    expect(extractTodos("The weather was nice and the coffee was strong.")).toEqual([]);
    expect(extractTodos("I think the report was already finished last week.")).toEqual([]);
  });

  test("ignores questions", () => {
    expect(extractTodos("Should we call him tomorrow?")).toEqual([]);
  });

  test("drops duplicates (case-insensitive)", () => {
    expect(extractTodos("Call John about the lease. Then call john about the lease.")).toEqual([
      "Call John about the lease",
    ]);
  });

  test("empty and tiny transcripts -> empty list", () => {
    expect(extractTodos("")).toEqual([]);
    expect(extractTodos("   ")).toEqual([]);
    expect(extractTodos("Hi.")).toEqual([]);
    expect(extractTodos("Um, so yeah.")).toEqual([]);
  });

  test("long sentences are truncated to ~140 chars", () => {
    const long = "Send an email to the entire steering committee about the quarterly budget reconciliation process and make sure to attach the spreadsheet " + "with all the numbers ".repeat(10) + ".";
    const items = extractTodos(long);
    expect(items).toHaveLength(1);
    expect(items[0].length).toBeLessThanOrEqual(140);
    expect(items[0].endsWith("…")).toBe(true);
  });

  test("handles multiple sentences, preserving order", () => {
    const items = extractTodos(
      "Good morning everyone. First, approve the minutes from last time. " +
        "The budget discussion went well. I need to draft the follow-up memo by Wednesday. " +
        "Any other business? Then let's adjourn the meeting."
    );
    expect(items).toEqual([
      "Approve the minutes from last time",
      "Draft the follow-up memo by Wednesday",
      "Adjourn the meeting",
    ]);
  });
});

// ---- API tests ----
let base = "";
let stop: () => void = () => {};
let tmp = "";
const OLD_BIN = process.env.WHISPER_BIN;

async function uploadWebm(title = "todo test") {
  const fd = new FormData();
  fd.append("audio", new File([new Uint8Array([1, 2, 3])], "note.webm", { type: "audio/webm" }));
  fd.append("title", title);
  const res = await fetch(base + "/api/recordings", { method: "POST", body: fd });
  return (await res.json()).recording.id as string;
}

const TRANSCRIPT =
  "We talked about the quarterly numbers. I need to send the budget report by Friday. " +
  "Don't forget to call the dentist. The weather was nice.";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "desk-todos-"));
  // make sure the offline engine does not pick up a leaked WHISPER_BIN from
  // another test file's env (bun shares env across files)
  process.env.WHISPER_BIN = join(tmp, "definitely-not-there");
  const { server } = buildApp({ port: 0, dataDir: tmp, dbPath: join(tmp, "t.db") });
  base = `http://localhost:${server.port}`;
  stop = () => server.stop();
});

afterAll(() => {
  stop();
  if (OLD_BIN === undefined) delete process.env.WHISPER_BIN;
  else process.env.WHISPER_BIN = OLD_BIN;
  rmSync(tmp, { recursive: true, force: true });
});

describe("todos API", () => {
  test("saving a transcript auto-extracts to-dos", async () => {
    const id = await uploadWebm();
    const r = await fetch(base + `/api/transcript/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: TRANSCRIPT }),
    });
    expect(r.status).toBe(200);
    const list = await (await fetch(base + `/api/recordings/${id}/todos`)).json();
    expect(list.todos.map((t: { text: string }) => t.text)).toEqual([
      "Send the budget report by Friday",
      "Call the dentist",
    ]);
    expect(list.todos[0].done).toBe(0);
  });

  test("empty transcript -> no to-dos", async () => {
    const id = await uploadWebm("empty");
    await fetch(base + `/api/transcript/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "Just some rambling with no action." }),
    });
    const list = await (await fetch(base + `/api/recordings/${id}/todos`)).json();
    expect(list.todos).toEqual([]);
  });

  test("extract endpoint merges idempotently and preserves done states", async () => {
    const id = await uploadWebm("merge");
    await fetch(base + `/api/transcript/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: TRANSCRIPT }),
    });
    let list = await (await fetch(base + `/api/recordings/${id}/todos`)).json();
    // mark the first item done
    const firstId = list.todos[0].id;
    const patched = await (
      await fetch(base + `/api/todos/${firstId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: 1 }),
      })
    ).json();
    expect(patched.todo.done).toBe(1);
    // re-extract: no new items, done preserved
    const ex = await (
      await fetch(base + `/api/recordings/${id}/todos/extract`, { method: "POST" })
    ).json();
    expect(ex.added).toBe(0);
    expect(ex.todos).toHaveLength(2);
    expect(ex.todos.find((t: { id: string }) => t.id === firstId).done).toBe(1);
    // a new sentence in the transcript adds only that item
    await fetch(base + `/api/transcript/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: TRANSCRIPT + " Book flights to Chicago next week." }),
    });
    list = await (await fetch(base + `/api/recordings/${id}/todos`)).json();
    expect(list.todos).toHaveLength(3);
    expect(list.todos[2].text).toBe("Book flights to Chicago next week");
    expect(list.todos.find((t: { id: string }) => t.id === firstId).done).toBe(1);
  });

  test("PATCH toggles done back and forth; rejects bad values", async () => {
    const id = await uploadWebm("toggle");
    await fetch(base + `/api/transcript/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: TRANSCRIPT }),
    });
    const list = await (await fetch(base + `/api/recordings/${id}/todos`)).json();
    const todoId = list.todos[0].id;
    const on = await (
      await fetch(base + `/api/todos/${todoId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: 1 }),
      })
    ).json();
    expect(on.todo.done).toBe(1);
    const off = await (
      await fetch(base + `/api/todos/${todoId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: false }),
      })
    ).json();
    expect(off.todo.done).toBe(0);
    const bad = await fetch(base + `/api/todos/${todoId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: 2 }),
    });
    expect(bad.status).toBe(400);
    const nf = await fetch(base + "/api/todos/nope", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: 1 }),
    });
    expect(nf.status).toBe(404);
  });

  test("DELETE removes an item; 404 for unknown", async () => {
    const id = await uploadWebm("del");
    await fetch(base + `/api/transcript/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: TRANSCRIPT }),
    });
    let list = await (await fetch(base + `/api/recordings/${id}/todos`)).json();
    expect(list.todos).toHaveLength(2);
    const res = await fetch(base + `/api/todos/${list.todos[0].id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    list = await (await fetch(base + `/api/recordings/${id}/todos`)).json();
    expect(list.todos).toHaveLength(1);
    const nf = await fetch(base + "/api/todos/nope", { method: "DELETE" });
    expect(nf.status).toBe(404);
  });

  test("unknown recording -> 404 on list and extract", async () => {
    expect((await fetch(base + "/api/recordings/nope/todos")).status).toBe(404);
    expect((await fetch(base + "/api/recordings/nope/todos/extract", { method: "POST" })).status).toBe(404);
  });

  test("deleting a recording removes its to-dos", async () => {
    const id = await uploadWebm("doomed");
    await fetch(base + `/api/transcript/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: TRANSCRIPT }),
    });
    const list = await (await fetch(base + `/api/recordings/${id}/todos`)).json();
    expect(list.todos.length).toBeGreaterThan(0);
    await fetch(base + `/api/recordings/${id}`, { method: "DELETE" });
    expect((await fetch(base + `/api/recordings/${id}/todos`)).status).toBe(404);
  });
});
