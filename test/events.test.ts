import { describe, test, expect } from "bun:test";
import { createEmitter, type EventEmitter } from "../src/observability/events.ts";

function capture(level: Parameters<typeof createEmitter>[0]["level"] = "debug"): {
  lines: string[];
  emitter: EventEmitter;
} {
  const lines: string[] = [];
  const emitter = createEmitter({
    level,
    sink: (line) => lines.push(line),
    clock: () => new Date("2026-04-23T00:00:00.000Z"),
  });
  return { lines, emitter };
}

describe("events — line format", () => {
  test("each emit writes a single line ending in newline", () => {
    const { lines, emitter } = capture();
    emitter.info("telegram.inbound", { update_id: 42 });
    expect(lines.length).toBe(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    expect(lines[0]!.split("\n").filter(Boolean).length).toBe(1);
  });

  test("payload is valid JSON with schema fields", () => {
    const { lines, emitter } = capture();
    emitter.info("telegram.inbound", { update_id: 42, job_id: "job_abc" });
    const record = JSON.parse(lines[0]!);
    expect(record.ts).toBe("2026-04-23T00:00:00.000Z");
    expect(record.level).toBe("info");
    expect(record.event).toBe("telegram.inbound");
    expect(record.update_id).toBe(42);
    expect(record.job_id).toBe("job_abc");
  });

  test("undefined fields are dropped", () => {
    const { lines, emitter } = capture();
    emitter.info("x", { job_id: undefined, a: 1 });
    const record = JSON.parse(lines[0]!);
    expect("job_id" in record).toBe(false);
    expect(record.a).toBe(1);
  });
});

describe("events — level filtering", () => {
  test("debug is dropped when level=info", () => {
    const { lines, emitter } = capture("info");
    emitter.debug("x");
    emitter.info("y");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).event).toBe("y");
  });

  test("warn and error pass through at info", () => {
    const { lines, emitter } = capture("info");
    emitter.warn("w");
    emitter.error("e");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).level).toBe("warn");
    expect(JSON.parse(lines[1]!).level).toBe("error");
  });

  test("only errors at level=error", () => {
    const { lines, emitter } = capture("error");
    emitter.debug("d");
    emitter.info("i");
    emitter.warn("w");
    emitter.error("e");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).level).toBe("error");
  });
});

describe("events — correlation via child()", () => {
  test("child merges bindings", () => {
    const { lines, emitter } = capture();
    const sub = emitter.child({ job_id: "job_1", session_id: "sess_a" });
    sub.info("queue.claim");
    const rec = JSON.parse(lines[0]!);
    expect(rec.job_id).toBe("job_1");
    expect(rec.session_id).toBe("sess_a");
  });

  test("child's fields can override binding for a single event", () => {
    const { lines, emitter } = capture();
    const sub = emitter.child({ job_id: "job_1" });
    sub.info("x", { job_id: "job_override" });
    expect(JSON.parse(lines[0]!).job_id).toBe("job_override");
  });

  test("grandchild preserves parent bindings", () => {
    const { lines, emitter } = capture();
    const c = emitter.child({ job_id: "j" });
    const gc = c.child({ session_id: "s" });
    gc.info("x");
    const rec = JSON.parse(lines[0]!);
    expect(rec.job_id).toBe("j");
    expect(rec.session_id).toBe("s");
  });

  test("sibling children do not share bindings", () => {
    const { lines, emitter } = capture();
    const a = emitter.child({ job_id: "a" });
    const b = emitter.child({ job_id: "b" });
    a.info("x");
    b.info("y");
    expect(JSON.parse(lines[0]!).job_id).toBe("a");
    expect(JSON.parse(lines[1]!).job_id).toBe("b");
  });
});

describe("events — field ordering", () => {
  test("schema fields come before user fields", () => {
    const { lines, emitter } = capture();
    emitter.info("x", { z: 1, a: 2 });
    // ts, level, event come first (in that order).
    const line = lines[0]!;
    const tsIdx = line.indexOf("\"ts\"");
    const levelIdx = line.indexOf("\"level\"");
    const eventIdx = line.indexOf("\"event\"");
    const zIdx = line.indexOf("\"z\"");
    expect(tsIdx).toBeGreaterThanOrEqual(0);
    expect(tsIdx).toBeLessThan(levelIdx);
    expect(levelIdx).toBeLessThan(eventIdx);
    expect(eventIdx).toBeLessThan(zIdx);
  });
});
