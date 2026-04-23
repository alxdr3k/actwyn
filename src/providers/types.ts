// Personal Agent P0 — provider adapter interface.
//
// Spec references:
//   - PRD §11 (provider adapter requirements)
//   - PRD Appendix B (AgentRequest / AgentResponse)
//   - HLD §4.4, §7.3, §14 (subprocess lifecycle — Phase 7)
//
// P0 is "Claude only" (PRD §11.2); the fake adapter lives in
// src/providers/fake.ts and is used by Phase 4 tests to exercise
// the worker without spawning a real subprocess.

export interface AgentRequest {
  readonly provider: string;
  readonly message: string;
  readonly session_id: string;
  readonly user_id: string;
  readonly channel: string;
  readonly chat_id: string;
  readonly project_id?: string | undefined;
  readonly cwd?: string | undefined;
  readonly system_context?: string | undefined;
  readonly injected_memory?: string | undefined;
  readonly attachments?: readonly AgentRequestAttachment[] | undefined;
  readonly timeout_s?: number | undefined;
  readonly priority?: number | undefined;
  readonly idempotency_key?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** When set, adapter uses `--resume` instead of `--session-id` (HLD §10.2). */
  readonly context_packing_mode?: "resume_mode" | "replay_mode" | undefined;
  /** Claude provider session ID to resume (only meaningful in resume_mode). */
  readonly provider_session_id?: string | undefined;
}

export interface AgentRequestAttachment {
  readonly storage_object_id: string;
  readonly local_path: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

export interface AgentRawEvent {
  readonly index: number;
  readonly stream: "stdout" | "stderr";
  readonly payload: string;
  readonly parser_status: "parsed" | "fallback_used" | "parse_error" | "unparsed";
}

export type ParserStatus = "parsed" | "fallback_used" | "parse_error";

export interface AgentResponse {
  readonly provider: string;
  readonly session_id: string;
  readonly final_text: string;
  readonly raw_events: readonly AgentRawEvent[];
  readonly usage?: Readonly<Record<string, unknown>> | undefined;
  readonly cost?: number | undefined;
  readonly duration_ms: number;
  readonly exit_code: number;
  readonly error_type?: string | undefined;
  readonly stderr?: string | undefined;
  readonly artifacts?: readonly unknown[] | undefined;
  readonly provider_version?: string | undefined;
  readonly parser_status: ParserStatus;
}

/** Outcome the worker can interpret. */
export type AgentOutcome =
  | { kind: "succeeded"; response: AgentResponse }
  | { kind: "failed"; response: AgentResponse; error_type: string }
  | { kind: "cancelled"; response: AgentResponse };

export interface ProviderAdapter {
  readonly name: string;
  run(
    req: AgentRequest,
    signal?: AbortSignal,
    onSpawn?: (pgid: number) => void,
  ): Promise<AgentOutcome>;
}
