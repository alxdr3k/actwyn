// Personal Agent P0 — structured JSON-line logger with correlation.
//
// Spec references:
//   - HLD §13.3 (structured JSON to stdout, captured by journald)
//   - HLD §13.4 (correlation keys flow across components)
//   - PRD §14.1 (minimal operational logs: latency, provider,
//     exit_code, timeout, retry_count, parser_error, queue wait)
//
// Invariants:
//   - Every emitted line is a single-line JSON object ending in "\n".
//   - Fields are ordered by stable schema; timestamps use ISO-8601 in
//     UTC with millisecond precision.
//   - The emitter itself NEVER formats raw payloads — callers redact
//     first via `observability/redact`. This keeps the single-
//     redactor invariant intact (HLD §13.1).
//   - Levels filter by threshold; level-below-threshold events are
//     dropped silently (no side-effect).

import type { LogLevel } from "~/config.ts";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface CorrelationKeys {
  readonly job_id?: string | undefined;
  readonly session_id?: string | undefined;
  readonly provider_session_id?: string | undefined;
  readonly update_id?: number | undefined;
  readonly notification_id?: string | undefined;
  readonly notification_type?: string | undefined;
  readonly storage_object_id?: string | undefined;
  readonly memory_id?: string | undefined;
}

export interface EventFields extends CorrelationKeys {
  readonly [key: string]: unknown;
}

export interface EmitterOptions {
  readonly level: LogLevel;
  readonly sink?: (line: string) => void;
  readonly clock?: () => Date;
}

export interface EventEmitter {
  readonly level: LogLevel;
  emit(level: LogLevel, event: string, fields?: EventFields): void;
  debug(event: string, fields?: EventFields): void;
  info(event: string, fields?: EventFields): void;
  warn(event: string, fields?: EventFields): void;
  error(event: string, fields?: EventFields): void;
  child(bindings: CorrelationKeys): EventEmitter;
}

export function createEmitter(opts: EmitterOptions): EventEmitter {
  const sink = opts.sink ?? ((line: string) => { process.stdout.write(line); });
  const clock = opts.clock ?? (() => new Date());
  return build(opts.level, sink, clock, {});
}

function build(
  level: LogLevel,
  sink: (line: string) => void,
  clock: () => Date,
  bindings: CorrelationKeys,
): EventEmitter {
  const threshold = LEVEL_ORDER[level];

  function emit(lvl: LogLevel, event: string, fields?: EventFields): void {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const record: Record<string, unknown> = {
      ts: clock().toISOString(),
      level: lvl,
      event,
      ...bindings,
      ...(fields ?? {}),
    };
    // Drop undefined values so the output stays compact.
    for (const k of Object.keys(record)) {
      if (record[k] === undefined) delete record[k];
    }
    sink(JSON.stringify(record) + "\n");
  }

  return {
    level,
    emit,
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child(extra: CorrelationKeys): EventEmitter {
      return build(level, sink, clock, { ...bindings, ...extra });
    },
  };
}
