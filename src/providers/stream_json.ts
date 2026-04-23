// Personal Agent P0 — stream-json parser with fallback.
//
// Spec references:
//   - PRD §11.2, §16.3 (parser fallback)
//   - HLD §7.3, §8.3 (redact → persist → parse, in that order)
//   - SP-04 (Claude stream-json shape pin)
//
// Responsibilities:
//   - Read stdout lines from the provider subprocess.
//   - Call the redactor on each raw line BEFORE any parse attempt
//     (HLD §7.8 — persisted raw bytes are always redacted).
//   - Try to parse the line as a known stream-json event. The exact
//     Claude event shape is pinned by SP-04; here we implement a
//     generic contract: `{event: "text" | "meta" | "tool_use" | ...}`.
//   - Assemble `final_text` from the concatenation of every `text`
//     event's `text` field. If JSON parse fails but the line is
//     plain text, the fallback path records it as a `fallback_used`
//     event and appends the raw text to `final_text`.
//   - Track a parser_status roll-up: `parsed` if every line parsed,
//     `fallback_used` if at least one line fell back to plain
//     text, `parse_error` if at least one line could not be
//     interpreted at all.

export type LineStream = "stdout" | "stderr";

export interface RawEvent {
  readonly index: number;
  readonly stream: LineStream;
  readonly payload: string;
  readonly parser_status: "parsed" | "fallback_used" | "parse_error" | "unparsed";
}

export interface ParsedLine {
  readonly event: RawEvent;
  readonly kind: "text" | "meta" | "tool_use" | "end" | "other" | "parse_error";
  readonly text_delta?: string;
  readonly provider_session_id?: string;
  readonly usage?: Record<string, unknown>;
}

export type ParserRollupStatus = "parsed" | "fallback_used" | "parse_error";

export interface ParseOneResult {
  readonly parsed: ParsedLine;
  readonly text_delta: string;
}

const PARSED_EVENTS = new Set(["text", "meta", "tool_use", "end"]);

/**
 * Pure single-line parser. Accepts a redacted line and classifies
 * it. Returns the parsed kind plus any text to append to
 * final_text.
 */
export function parseLine(line: string, index: number, stream: LineStream): ParseOneResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    // Empty lines are parsed-but-useless; no fallback.
    return {
      parsed: {
        event: { index, stream, payload: line, parser_status: "parsed" },
        kind: "other",
      },
      text_delta: "",
    };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Plain-text fallback: whole line counts as final_text.
    return {
      parsed: {
        event: { index, stream, payload: line, parser_status: "fallback_used" },
        kind: "other",
      },
      text_delta: stream === "stdout" ? trimmed : "",
    };
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return {
      parsed: {
        event: { index, stream, payload: line, parser_status: "fallback_used" },
        kind: "other",
      },
      text_delta: "",
    };
  }

  const o = obj as Record<string, unknown>;
  const evt = typeof o.event === "string" ? o.event : null;
  if (!evt || !PARSED_EVENTS.has(evt)) {
    return {
      parsed: {
        event: { index, stream, payload: line, parser_status: "parsed" },
        kind: "other",
      },
      text_delta: "",
    };
  }

  if (evt === "text") {
    const text = typeof o.text === "string" ? o.text : "";
    return {
      parsed: {
        event: { index, stream, payload: line, parser_status: "parsed" },
        kind: "text",
        text_delta: text,
      },
      text_delta: text,
    };
  }

  if (evt === "meta") {
    const provider_session_id =
      typeof o.provider_session_id === "string" ? o.provider_session_id : undefined;
    const usage = isRecord(o.usage) ? o.usage : undefined;
    return {
      parsed: {
        event: { index, stream, payload: line, parser_status: "parsed" },
        kind: "meta",
        ...(provider_session_id ? { provider_session_id } : {}),
        ...(usage ? { usage } : {}),
      },
      text_delta: "",
    };
  }

  if (evt === "tool_use") {
    return {
      parsed: {
        event: { index, stream, payload: line, parser_status: "parsed" },
        kind: "tool_use",
      },
      text_delta: "",
    };
  }

  // evt === "end"
  return {
    parsed: {
      event: { index, stream, payload: line, parser_status: "parsed" },
      kind: "end",
    },
    text_delta: "",
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------
// Assembler — aggregates lines across one run.
// ---------------------------------------------------------------

export interface Assembled {
  readonly events: readonly RawEvent[];
  readonly final_text: string;
  readonly parser_status: ParserRollupStatus;
  readonly provider_session_id?: string;
  readonly usage?: Record<string, unknown>;
  readonly saw_end: boolean;
}

export class StreamAssembler {
  private events: RawEvent[] = [];
  private texts: string[] = [];
  private lineIndex = 0;
  private _provider_session_id: string | undefined;
  private _usage: Record<string, unknown> | undefined;
  private _saw_end = false;

  /** Feed a redacted line; MUST already have been routed through the redactor. */
  push(line: string, stream: LineStream): ParsedLine {
    const { parsed, text_delta } = parseLine(line, this.lineIndex, stream);
    this.events.push(parsed.event);
    if (text_delta) this.texts.push(text_delta);
    if (parsed.kind === "meta") {
      if (parsed.provider_session_id) this._provider_session_id = parsed.provider_session_id;
      if (parsed.usage) this._usage = parsed.usage;
    } else if (parsed.kind === "end") {
      this._saw_end = true;
    }
    this.lineIndex += 1;
    return parsed;
  }

  finish(args: { subprocess_exit_code: number } = { subprocess_exit_code: 0 }): Assembled {
    const hasFallback = this.events.some((e) => e.parser_status === "fallback_used");
    const hasError = this.events.some((e) => e.parser_status === "parse_error");
    const nonTrivialLines = this.events.some(
      (e) => e.parser_status !== "unparsed" && e.payload.trim().length > 0,
    );
    let status: ParserRollupStatus;
    if (hasError) status = "parse_error";
    else if (hasFallback) status = "fallback_used";
    else status = "parsed";

    // Parser fallback per PRD §16.3: if the subprocess exited 0 but
    // we never saw an `end` event and never parsed a `text` event,
    // promote status to `fallback_used` and keep whatever raw text
    // we collected.
    if (
      args.subprocess_exit_code === 0 &&
      !this._saw_end &&
      status === "parsed" &&
      nonTrivialLines
    ) {
      status = "fallback_used";
    }

    return {
      events: this.events,
      final_text: this.texts.join(""),
      parser_status: status,
      ...(this._provider_session_id ? { provider_session_id: this._provider_session_id } : {}),
      ...(this._usage ? { usage: this._usage } : {}),
      saw_end: this._saw_end,
    };
  }
}

// ---------------------------------------------------------------
// Line reader over a stream of bytes (async iterator).
// ---------------------------------------------------------------

export async function* readLines(
  stream: ReadableStream<Uint8Array> | null,
): AsyncIterable<string> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        yield line;
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
