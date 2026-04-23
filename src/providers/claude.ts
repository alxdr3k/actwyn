// Personal Agent P0 — Claude Code CLI provider adapter.
//
// Spec references:
//   - PRD §11.2 (Claude as P0 provider)
//   - HLD §4.4, §7.3, §8 (profile-aware argv), §14 (subprocess)
//   - PRD Appendix E (forbidden flags: --dangerously-skip-permissions,
//     --no-session-persistence, etc.)
//
// P0 spawn profile (conversational):
//   claude <message>
//     --session-id <session-id>           # or --resume in resume_mode
//     --output-format stream-json
//     --tools ""                          # lockdown per HLD §4.4 / PRD §11.2
//     --permission-mode dontAsk           # no interactive prompts
//     --max-turns <n>
//
// The adapter is tested with a fake binary that emits stream-json
// in the same event shape the parser understands; the real Claude
// binary pin lives behind SP-04 / SP-05. This module therefore
// exposes a `binary` option so tests substitute it cleanly.

import type { Redactor } from "~/observability/redact.ts";
import type {
  AgentOutcome,
  AgentRequest,
  AgentResponse,
  ProviderAdapter,
} from "~/providers/types.ts";
import {
  readLines,
  StreamAssembler,
} from "~/providers/stream_json.ts";
import { spawnDetached, SubprocessError } from "~/providers/subprocess.ts";

// PRD Appendix E forbidden flags — refuse to spawn if a caller
// tries to wire them in.
const FORBIDDEN_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--no-session-persistence",
];

export type ClaudeProfile = "conversational" | "advisory";

export interface ClaudeAdapterOptions {
  /** Path to the Claude binary. Overridden in tests. */
  readonly binary: string;
  /** Extra argv appended after the message (advanced / optional). */
  readonly extra_argv?: readonly string[];
  readonly profile?: ClaudeProfile;
  readonly max_turns?: number;
  readonly grace_ms?: number;
  readonly hard_kill_ms?: number;
  readonly redactor: Redactor;
  readonly now?: () => Date;
  /** Host cwd for the subprocess. */
  readonly cwd: string;
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions): ProviderAdapter {
  const profile: ClaudeProfile = opts.profile ?? "conversational";
  const now = opts.now ?? (() => new Date());

  async function run(
    req: AgentRequest,
    signal?: AbortSignal,
  ): Promise<AgentOutcome> {
    const started = now().getTime();
    let argv: string[];
    let child;
    try {
      argv = buildArgv({
        binary: opts.binary,
        profile,
        message: req.message,
        session_id: req.session_id,
        max_turns: opts.max_turns ?? 12,
        extra: opts.extra_argv ?? [],
      });
      ensureNoForbidden(argv);
      child = spawnDetached({
        argv,
        cwd: opts.cwd,
        ...(opts.grace_ms !== undefined ? { grace_ms: opts.grace_ms } : {}),
        ...(opts.hard_kill_ms !== undefined ? { hard_kill_ms: opts.hard_kill_ms } : {}),
      });
    } catch (e) {
      const error_type =
        e instanceof SubprocessError ? `spawn_${e.phase}` :
        (e as Error).message.startsWith("forbidden flag") ? "forbidden_flag" :
        "spawn_failed";
      return failed({
        provider: "claude",
        error_type,
        message: (e as Error).message,
        started,
        now,
      });
    }

    const assembler = new StreamAssembler();

    // Cancel on signal: fire teardown, mark cancelled_after_start.
    const cancelPromise = new Promise<"cancel">((resolve) => {
      signal?.addEventListener("abort", () => resolve("cancel"), { once: true });
    });

    const stdoutTask = (async () => {
      for await (const line of readLines(child.stdout)) {
        const redacted = opts.redactor.apply(line).text;
        assembler.push(redacted, "stdout");
      }
    })();

    const stderrTask = (async () => {
      for await (const line of readLines(child.stderr)) {
        const redacted = opts.redactor.apply(line).text;
        assembler.push(redacted, "stderr");
      }
    })();

    // Race subprocess exit vs cancel.
    const finish = await Promise.race([
      child.exited.then((code) => ({ kind: "exit" as const, code })),
      cancelPromise,
    ]);

    if (finish === "cancel") {
      try {
        await child.teardown(signal ?? new AbortController().signal);
      } catch {
        // Teardown failure is already logged in the subprocess module;
        // continue so we don't leave the caller hanging.
      }
    }

    // Drain streams either way — even under cancel, readers must
    // terminate cleanly so we don't leak listeners.
    await Promise.allSettled([stdoutTask, stderrTask]);

    const exitCode = finish === "cancel" ? await child.exited : finish.code;
    const assembled = assembler.finish({ subprocess_exit_code: exitCode });

    const base: AgentResponse = {
      provider: "claude",
      session_id: assembled.provider_session_id ?? req.session_id,
      final_text: assembled.final_text,
      raw_events: assembled.events,
      duration_ms: now().getTime() - started,
      exit_code: exitCode,
      parser_status: assembled.parser_status,
      ...(assembled.usage ? { usage: assembled.usage } : {}),
    };

    if (finish === "cancel") {
      const response: AgentResponse = {
        ...base,
        error_type: "cancelled",
      };
      return { kind: "cancelled", response };
    }

    if (exitCode !== 0) {
      const response: AgentResponse = {
        ...base,
        error_type: classifyExitCode(exitCode),
      };
      return { kind: "failed", response, error_type: classifyExitCode(exitCode) };
    }

    return { kind: "succeeded", response: base };
  }

  return {
    name: "claude",
    run,
  };
}

// ---------------------------------------------------------------
// argv construction (PRD §11.2)
// ---------------------------------------------------------------

function buildArgv(args: {
  binary: string;
  profile: ClaudeProfile;
  message: string;
  session_id: string;
  max_turns: number;
  extra: readonly string[];
}): string[] {
  const out: string[] = [args.binary, args.message];
  if (args.session_id) {
    out.push("--session-id", args.session_id);
  }
  out.push("--output-format", "stream-json");
  // Lockdown per HLD §4.4 / PRD §11.2: no tools, no interactive prompts.
  out.push("--tools", "");
  out.push("--permission-mode", "dontAsk");
  out.push("--max-turns", String(args.max_turns));
  for (const a of args.extra) out.push(a);
  return out;
}

function ensureNoForbidden(argv: readonly string[]): void {
  for (const a of argv) {
    if (FORBIDDEN_FLAGS.includes(a)) {
      throw new Error(`forbidden flag: ${a} (PRD Appendix E)`);
    }
  }
}

function classifyExitCode(code: number): string {
  if (code === 124) return "timeout";
  if (code === 137) return "sigkill";
  if (code === 143) return "sigterm";
  if (code === 130) return "sigint";
  return "non_zero_exit";
}

function failed(args: {
  provider: string;
  error_type: string;
  message: string;
  started: number;
  now: () => Date;
}): AgentOutcome {
  const response: AgentResponse = {
    provider: args.provider,
    session_id: "",
    final_text: "",
    raw_events: [],
    duration_ms: args.now().getTime() - args.started,
    exit_code: 1,
    parser_status: "parse_error",
    error_type: args.error_type,
    stderr: args.message,
  };
  return { kind: "failed", response, error_type: args.error_type };
}
