// Personal Agent P0 — Claude Code CLI provider adapter.
//
// Spec references:
//   - PRD §11.2 (Claude as P0 provider)
//   - HLD §4.4, §7.3, §8 (profile-aware argv), §14 (subprocess)
//   - PRD Appendix E (forbidden flags: --dangerously-skip-permissions,
//     --no-session-persistence, etc.)
//
// P0 spawn profile (conversational):
//   claude -p <message>                   # print mode — non-interactive, exits when done
//     --output-format stream-json
//     --session-id <session-id>           # or --resume in resume_mode
//     --tools ""                          # lockdown per HLD §4.4 / PRD §11.2
//     --permission-mode dontAsk           # no interactive prompts
//     --max-turns <n>
//
// Without `-p`, the Claude CLI treats the positional argument as the
// initial prompt of an INTERACTIVE session and will not exit on its
// own — spawns would then always hit the stall/runtime timers. Print
// mode (`-p`) is the documented SDK/non-interactive entry point.
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
  /** Maximum wall-clock ms for the whole run (HLD §14.2). Triggers teardown when exceeded. */
  readonly max_runtime_ms?: number;
  /** Max ms of stream silence before treating as subprocess stall (HLD §14.2). */
  readonly stall_timeout_ms?: number;
  /** Max total stdout+stderr bytes before teardown (HLD §14.3). */
  readonly max_output_bytes?: number;
  /** Max prompt byte length; job fails before spawn if exceeded (AC-PROV-013). */
  readonly max_prompt_bytes?: number;
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
    onSpawn?: (pgid: number, pid: number) => void,
  ): Promise<AgentOutcome> {
    const started = now().getTime();
    let argv: string[];
    let child;
    try {
      // AC-PROV-013: fail before spawn if message exceeds max_prompt_bytes.
      // Review Medium 10: the option is named *_bytes and is compared against
      // argv length, which the OS measures in bytes. For Korean (multi-byte
      // UTF-8) prompts, String#length under-reports the byte size by up to
      // 3×, so we must use TextEncoder to measure actual encoded bytes.
      if (opts.max_prompt_bytes !== undefined) {
        const promptBytes = new TextEncoder().encode(req.message).byteLength;
        if (promptBytes > opts.max_prompt_bytes) {
          return failed({
            provider: "claude",
            error_type: "prompt_too_large",
            message: `prompt byte length ${promptBytes} exceeds max_prompt_bytes ${opts.max_prompt_bytes}`,
            started,
            now,
          });
        }
      }
      argv = buildArgv({
        binary: opts.binary,
        profile,
        message: req.message,
        session_id: req.session_id,
        max_turns: opts.max_turns ?? 12,
        extra: opts.extra_argv ?? [],
        ...(req.context_packing_mode ? { context_packing_mode: req.context_packing_mode } : {}),
        ...(req.provider_session_id ? { provider_session_id: req.provider_session_id } : {}),
      });
      ensureNoForbidden(argv);
      // High Priority 7: provide a curated env rather than inheriting nothing.
      // Bun spawn with an empty/absent env may omit PATH/HOME/USER which Claude
      // CLI needs to locate its binary, auth tokens, and session files. We pass
      // a whitelist so that secrets present only in process.env are not leaked
      // into the subprocess (defence-in-depth alongside the redactor).
      const curatedEnv: Record<string, string> = {};
      const envKeys = ["PATH", "HOME", "USER", "SHELL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR", "TERM"] as const;
      for (const k of envKeys) {
        const v = process.env[k];
        if (v !== undefined) curatedEnv[k] = v;
      }
      child = spawnDetached({
        argv,
        cwd: opts.cwd,
        env: curatedEnv,
        ...(opts.grace_ms !== undefined ? { grace_ms: opts.grace_ms } : {}),
        ...(opts.hard_kill_ms !== undefined ? { hard_kill_ms: opts.hard_kill_ms } : {}),
      });
      onSpawn?.(child.process_group_id, child.pid);
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

    // max_runtime_ms: absolute wall-clock limit (HLD §14.2 / §14.3).
    const maxRuntimePromise: Promise<"timeout_max_runtime"> = opts.max_runtime_ms !== undefined
      ? new Promise((resolve) => setTimeout(() => resolve("timeout_max_runtime"), opts.max_runtime_ms))
      : new Promise(() => { /* never */ });

    // stall_timeout_ms: silence detection (HLD §14.2). Timer resets on each output line.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveStall: ((v: "timeout_stall") => void) | null = null;
    const stallPromise: Promise<"timeout_stall"> = opts.stall_timeout_ms !== undefined
      ? new Promise((resolve) => {
          resolveStall = resolve;
          stallTimer = setTimeout(() => resolve("timeout_stall"), opts.stall_timeout_ms);
        })
      : new Promise(() => { /* never */ });

    function resetStall(): void {
      if (opts.stall_timeout_ms === undefined || stallTimer === null) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => resolveStall!("timeout_stall"), opts.stall_timeout_ms);
    }

    // max_output_bytes: total stdout+stderr byte cap (HLD §14.3). Triggers teardown when exceeded.
    let totalOutputBytes = 0;
    let resolveOutputLimit: ((v: "timeout_output_limit") => void) | null = null;
    const outputLimitPromise: Promise<"timeout_output_limit"> = opts.max_output_bytes !== undefined
      ? new Promise((resolve) => { resolveOutputLimit = resolve; })
      : new Promise(() => { /* never */ });

    function trackOutputBytes(line: string): void {
      if (opts.max_output_bytes === undefined || resolveOutputLimit === null) return;
      // Medium 9: use byte length (UTF-8 encoded) to correctly enforce limits
      // for Korean / CJK / emoji output where char length < byte length.
      totalOutputBytes += new TextEncoder().encode(line).byteLength;
      if (totalOutputBytes > opts.max_output_bytes) resolveOutputLimit("timeout_output_limit");
    }

    const stdoutTask = (async () => {
      for await (const line of readLines(child.stdout)) {
        resetStall();
        trackOutputBytes(line);
        const redacted = opts.redactor.apply(line).text;
        assembler.push(redacted, "stdout");
      }
    })();

    const stderrTask = (async () => {
      for await (const line of readLines(child.stderr)) {
        resetStall();
        trackOutputBytes(line);
        const redacted = opts.redactor.apply(line).text;
        assembler.push(redacted, "stderr");
      }
    })();

    // Race subprocess exit vs cancel vs timeouts.
    type FinishKind =
      | { kind: "exit"; code: number }
      | "cancel"
      | "timeout_max_runtime"
      | "timeout_stall"
      | "timeout_output_limit";

    const finish: FinishKind = await Promise.race([
      child.exited.then((code) => ({ kind: "exit" as const, code })),
      cancelPromise,
      maxRuntimePromise,
      stallPromise,
      outputLimitPromise,
    ]);

    // Clear stall timer so it doesn't fire after the race resolves.
    if (stallTimer !== null) clearTimeout(stallTimer);

    const isTimeout =
      finish === "timeout_max_runtime" || finish === "timeout_stall" || finish === "timeout_output_limit";

    if (finish === "cancel" || isTimeout) {
      try {
        await child.teardown(signal ?? new AbortController().signal);
      } catch {
        // Teardown failure is already logged in the subprocess module;
        // continue so we don't leave the caller hanging.
      }
    }

    // Drain streams either way — even under cancel/timeout, readers must
    // terminate cleanly so we don't leak listeners.
    await Promise.allSettled([stdoutTask, stderrTask]);

    const exitCode =
      finish === "cancel" || isTimeout ? await child.exited : finish.code;
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

    if (isTimeout) {
      const error_type = finish === "timeout_stall" ? "stall_timeout"
        : finish === "timeout_output_limit" ? "output_limit_exceeded"
        : "timeout";
      const response: AgentResponse = { ...base, error_type };
      return { kind: "failed", response, error_type };
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

export function buildClaudeArgv(args: {
  binary: string;
  profile: ClaudeProfile;
  message: string;
  session_id: string;
  max_turns: number;
  extra: readonly string[];
  context_packing_mode?: "resume_mode" | "replay_mode";
  provider_session_id?: string;
}): string[] {
  // `-p <message>` is print mode: non-interactive, exits when done.
  // Must come before other flags so the adapter contract is easy to
  // assert in tests (argv[1] === "-p").
  // --verbose required alongside --output-format stream-json since CLI 2.1.x
  const out: string[] = [args.binary, "-p", args.message, "--output-format", "stream-json", "--verbose"];
  if (args.context_packing_mode === "resume_mode" && args.provider_session_id) {
    out.push("--resume", args.provider_session_id);
  } else if (args.session_id) {
    out.push("--session-id", args.session_id);
  }
  // Lockdown per HLD §4.4 / PRD §11.2: no tools, no interactive prompts.
  out.push("--tools", "");
  out.push("--permission-mode", "dontAsk");
  out.push("--max-turns", String(args.max_turns));
  for (const a of args.extra) out.push(a);
  return out;
}

function buildArgv(args: {
  binary: string;
  profile: ClaudeProfile;
  message: string;
  session_id: string;
  max_turns: number;
  extra: readonly string[];
  context_packing_mode?: "resume_mode" | "replay_mode";
  provider_session_id?: string;
}): string[] {
  return buildClaudeArgv(args);
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
