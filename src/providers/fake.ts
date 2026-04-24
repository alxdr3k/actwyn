// Personal Agent P0 — fake provider adapter.
//
// Deterministic stand-in for the real Claude adapter (Phase 7).
// Echoes the user message and supports scripted failure/cancel
// behaviors so the worker state machine can be exercised without
// a real subprocess.

import type {
  AgentOutcome,
  AgentRawEvent,
  AgentRequest,
  AgentResponse,
  ProviderAdapter,
} from "~/providers/types.ts";

export type FakeMode =
  | { kind: "ok" }
  | { kind: "partial"; final_text_override: string }
  | { kind: "error"; error_type: string; exit_code: number; stderr?: string }
  | { kind: "timeout"; after_ms: number }
  | { kind: "cancel_on_signal" };

export interface FakeAdapterOptions {
  readonly mode?: FakeMode;
  readonly session_id?: string;
  readonly provider_version?: string;
  readonly duration_ms?: number;
  readonly now?: () => Date;
}

export function createFakeAdapter(opts: FakeAdapterOptions = {}): ProviderAdapter {
  const mode: FakeMode = opts.mode ?? { kind: "ok" };
  const session_id = opts.session_id ?? "fake-session";
  const provider_version = opts.provider_version ?? "fake-1.0";

  async function run(
    req: AgentRequest,
    signal?: AbortSignal,
    _onSpawn?: (pgid: number, pid: number) => void,
  ): Promise<AgentOutcome> {
    const started = (opts.now ?? (() => new Date()))().getTime();
    const events: AgentRawEvent[] = [
      {
        index: 0,
        stream: "stdout",
        payload: JSON.stringify({ event: "start", provider: req.provider }),
        parser_status: "parsed",
      },
    ];

    if (mode.kind === "cancel_on_signal") {
      if (signal?.aborted) {
        return buildCancelled(req, session_id, provider_version, events, started, opts);
      }
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return buildCancelled(req, session_id, provider_version, events, started, opts);
    }

    if (mode.kind === "timeout") {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, mode.after_ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
      if (signal?.aborted) {
        return buildCancelled(req, session_id, provider_version, events, started, opts);
      }
      // Fall through: a timeout still reports failure with error_type=timeout.
      const failed = buildResponse({
        req,
        session_id,
        provider_version,
        events,
        started,
        now: opts.now,
        duration_ms: opts.duration_ms,
        final_text: "",
        parser_status: "parse_error",
        exit_code: 124,
        error_type: "timeout",
      });
      return { kind: "failed", response: failed, error_type: "timeout" };
    }

    if (mode.kind === "error") {
      events.push({
        index: 1,
        stream: "stderr",
        payload: `ERROR ${mode.error_type}`,
        parser_status: "fallback_used",
      });
      const failed = buildResponse({
        req,
        session_id,
        provider_version,
        events,
        started,
        now: opts.now,
        duration_ms: opts.duration_ms,
        final_text: "",
        parser_status: "parse_error",
        exit_code: mode.exit_code,
        error_type: mode.error_type,
        stderr: mode.stderr,
      });
      return { kind: "failed", response: failed, error_type: mode.error_type };
    }

    const final_text =
      mode.kind === "partial" ? mode.final_text_override : `echo: ${req.message}`;
    events.push({
      index: 1,
      stream: "stdout",
      payload: JSON.stringify({ event: "text", text: final_text }),
      parser_status: "parsed",
    });
    events.push({
      index: 2,
      stream: "stdout",
      payload: JSON.stringify({ event: "end" }),
      parser_status: "parsed",
    });

    const ok = buildResponse({
      req,
      session_id,
      provider_version,
      events,
      started,
      now: opts.now,
      duration_ms: opts.duration_ms,
      final_text,
      parser_status: mode.kind === "partial" ? "fallback_used" : "parsed",
      exit_code: 0,
    });
    return { kind: "succeeded", response: ok };
  }

  return {
    name: "fake",
    run,
  };
}

function buildCancelled(
  req: AgentRequest,
  session_id: string,
  provider_version: string,
  events: AgentRawEvent[],
  started: number,
  opts: FakeAdapterOptions,
): AgentOutcome {
  const response = buildResponse({
    req,
    session_id,
    provider_version,
    events,
    started,
    now: opts.now,
    duration_ms: opts.duration_ms,
    final_text: "",
    parser_status: "parse_error",
    exit_code: 137,
    error_type: "cancelled",
  });
  return { kind: "cancelled", response };
}

function buildResponse(args: {
  req: AgentRequest;
  session_id: string;
  provider_version: string;
  events: AgentRawEvent[];
  started: number;
  now?: (() => Date) | undefined;
  duration_ms?: number | undefined;
  final_text: string;
  parser_status: "parsed" | "fallback_used" | "parse_error";
  exit_code: number;
  error_type?: string | undefined;
  stderr?: string | undefined;
}): AgentResponse {
  const now = args.now ?? (() => new Date());
  const duration_ms =
    args.duration_ms !== undefined ? args.duration_ms : now().getTime() - args.started;
  return {
    provider: args.req.provider,
    session_id: args.session_id,
    final_text: args.final_text,
    raw_events: args.events,
    duration_ms,
    exit_code: args.exit_code,
    parser_status: args.parser_status,
    ...(args.error_type ? { error_type: args.error_type } : {}),
    ...(args.stderr ? { stderr: args.stderr } : {}),
    provider_version: args.provider_version,
  };
}
