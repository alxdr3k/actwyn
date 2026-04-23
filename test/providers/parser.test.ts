import { describe, test, expect } from "bun:test";
import {
  parseLine,
  readLines,
  StreamAssembler,
} from "../../src/providers/stream_json.ts";

describe("parseLine — classified events", () => {
  test("text event contributes to final_text", () => {
    const r = parseLine(JSON.stringify({ event: "text", text: "hello " }), 0, "stdout");
    expect(r.parsed.kind).toBe("text");
    expect(r.text_delta).toBe("hello ");
    expect(r.parsed.event.parser_status).toBe("parsed");
  });

  test("meta event surfaces provider_session_id and usage", () => {
    const r = parseLine(
      JSON.stringify({
        event: "meta",
        provider_session_id: "claude-abc",
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
      1,
      "stdout",
    );
    expect(r.parsed.kind).toBe("meta");
    expect(r.parsed.provider_session_id).toBe("claude-abc");
    expect(r.parsed.usage?.input_tokens).toBe(12);
  });

  test("tool_use event is recognised, contributes no text", () => {
    const r = parseLine(JSON.stringify({ event: "tool_use", name: "bash" }), 2, "stdout");
    expect(r.parsed.kind).toBe("tool_use");
    expect(r.text_delta).toBe("");
  });

  test("end event flips saw_end", () => {
    const r = parseLine(JSON.stringify({ event: "end" }), 3, "stdout");
    expect(r.parsed.kind).toBe("end");
  });

  test("unknown event is parsed but treated as other", () => {
    const r = parseLine(JSON.stringify({ event: "mystery" }), 4, "stdout");
    expect(r.parsed.kind).toBe("other");
    expect(r.parsed.event.parser_status).toBe("parsed");
  });
});

describe("parseLine — fallback path", () => {
  test("plain text line (non-JSON) on stdout contributes to final_text with fallback_used", () => {
    const r = parseLine("I am a plain string", 0, "stdout");
    expect(r.parsed.event.parser_status).toBe("fallback_used");
    expect(r.text_delta).toBe("I am a plain string");
  });

  test("plain text on stderr does NOT contribute to final_text", () => {
    const r = parseLine("error: something", 0, "stderr");
    expect(r.parsed.event.parser_status).toBe("fallback_used");
    expect(r.text_delta).toBe("");
  });

  test("array JSON falls back (not our shape)", () => {
    const r = parseLine(JSON.stringify([1, 2, 3]), 0, "stdout");
    expect(r.parsed.event.parser_status).toBe("fallback_used");
  });

  test("empty string is parsed-trivially with no delta", () => {
    const r = parseLine("", 0, "stdout");
    expect(r.parsed.event.parser_status).toBe("parsed");
    expect(r.text_delta).toBe("");
  });
});

describe("StreamAssembler — roll-up", () => {
  test("all-parsed run with text + end: final_text is concatenation; parser_status='parsed'", () => {
    const a = new StreamAssembler();
    a.push(JSON.stringify({ event: "meta", provider_session_id: "s1" }), "stdout");
    a.push(JSON.stringify({ event: "text", text: "Hello " }), "stdout");
    a.push(JSON.stringify({ event: "text", text: "world" }), "stdout");
    a.push(JSON.stringify({ event: "end" }), "stdout");
    const r = a.finish({ subprocess_exit_code: 0 });
    expect(r.final_text).toBe("Hello world");
    expect(r.parser_status).toBe("parsed");
    expect(r.provider_session_id).toBe("s1");
    expect(r.saw_end).toBe(true);
    expect(r.events.length).toBe(4);
  });

  test("mixed run with a fallback line: parser_status='fallback_used'", () => {
    const a = new StreamAssembler();
    a.push(JSON.stringify({ event: "text", text: "Hi " }), "stdout");
    a.push("(plain)", "stdout");
    a.push(JSON.stringify({ event: "end" }), "stdout");
    const r = a.finish({ subprocess_exit_code: 0 });
    expect(r.parser_status).toBe("fallback_used");
    expect(r.final_text).toContain("Hi ");
    expect(r.final_text).toContain("(plain)");
  });

  test("no 'end' event on exit=0 but some text → status promoted to fallback_used", () => {
    const a = new StreamAssembler();
    a.push(JSON.stringify({ event: "text", text: "A" }), "stdout");
    const r = a.finish({ subprocess_exit_code: 0 });
    expect(r.saw_end).toBe(false);
    expect(r.parser_status).toBe("fallback_used");
    expect(r.final_text).toBe("A");
  });

  test("empty run → parser_status='parsed', final_text=''", () => {
    const a = new StreamAssembler();
    const r = a.finish({ subprocess_exit_code: 0 });
    expect(r.parser_status).toBe("parsed");
    expect(r.final_text).toBe("");
  });

  test("forcibly truncated: only text lines present, no end → fallback yields final_text", () => {
    const a = new StreamAssembler();
    a.push(JSON.stringify({ event: "text", text: "partial" }), "stdout");
    a.push(JSON.stringify({ event: "text", text: " answer" }), "stdout");
    const r = a.finish({ subprocess_exit_code: 0 });
    expect(r.final_text).toBe("partial answer");
    expect(r.parser_status).toBe("fallback_used");
    expect(r.saw_end).toBe(false);
  });
});

describe("readLines — splits newline-delimited stream", () => {
  test("consumes multi-chunk streams", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode("{\"event\":\"text\"}\n{\"event\":"));
        c.enqueue(encoder.encode("\"end\"}\n"));
        c.close();
      },
    });
    const lines: string[] = [];
    for await (const l of readLines(stream)) lines.push(l);
    expect(lines).toEqual([`{"event":"text"}`, `{"event":"end"}`]);
  });

  test("trailing unterminated line is still yielded", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode("no-newline-here"));
        c.close();
      },
    });
    const lines: string[] = [];
    for await (const l of readLines(stream)) lines.push(l);
    expect(lines).toEqual(["no-newline-here"]);
  });
});
