// Personal Agent P0 — context builder.
//
// Assembles the "slots" per PRD §12.4–12.5 into a structured
// ContextSnapshot that the packer then prunes within a token
// budget.
//
// Slots (in priority order from most to least important — this
// order is also the REVERSE of the drop precedence):
//   1. user_message         (MUST always survive)
//   2. system_identity      (MUST always survive — minimal form)
//   3. active_project_context
//   4. current_session_summary
//   5. user_stated_preferences (memory items with provenance ∈ {user_stated, user_confirmed})
//   6. recent_turns         (only in replay_mode)
//   7. other_memory         (inferred / tool_output / assistant_generated)
//   8. inactive_project_context
//   9. verbose_transcript   (fallback notes)
//
// The builder is pure. It does NOT read the DB directly; callers
// pass the data it needs (typically src/queue/worker.ts).

export type PackingMode = "resume_mode" | "replay_mode";

export interface MemoryItemSlot {
  readonly id: string;
  readonly content: string;
  readonly provenance: string; // matches PRD §12.2 vocabulary
  readonly confidence: number;
  readonly status: string; // must be 'active' to be injected
}

export interface TurnSlot {
  readonly id: string;
  readonly role: string;
  readonly content_redacted: string;
  readonly created_at: string;
}

export interface BuildInput {
  readonly mode: PackingMode;
  readonly user_message: string;
  readonly system_identity: string;
  readonly active_project_context?: string | undefined;
  readonly inactive_project_context?: string | undefined;
  readonly current_session_summary?: string | undefined;
  readonly recent_turns?: readonly TurnSlot[] | undefined;
  readonly memory_items?: readonly MemoryItemSlot[] | undefined;
  readonly verbose_transcript?: string | undefined;
}

export interface ContextSlot {
  readonly key: SlotKey;
  readonly label: string;
  readonly text: string;
  readonly priority: number; // higher = retain; lower = drop first
  readonly droppable: boolean;
}

export type SlotKey =
  | "user_message"
  | "system_identity"
  | "active_project_context"
  | "inactive_project_context"
  | "current_session_summary"
  | "memory_user_stated"
  | "memory_other"
  | "recent_turns"
  | "verbose_transcript";

export interface ContextSnapshot {
  readonly mode: PackingMode;
  readonly slots: readonly ContextSlot[];
}

export function buildContext(input: BuildInput): ContextSnapshot {
  const slots: ContextSlot[] = [];

  slots.push({
    key: "user_message",
    label: "user_message",
    text: input.user_message,
    priority: 1000,
    droppable: false,
  });
  slots.push({
    key: "system_identity",
    label: "system_identity",
    text: input.system_identity,
    priority: 900,
    droppable: false,
  });

  if (input.active_project_context) {
    slots.push({
      key: "active_project_context",
      label: "active_project_context",
      text: input.active_project_context,
      priority: 800,
      droppable: true,
    });
  }

  if (input.current_session_summary) {
    slots.push({
      key: "current_session_summary",
      label: "current_session_summary",
      text: input.current_session_summary,
      priority: 780,
      droppable: true,
    });
  }

  const activeItems = (input.memory_items ?? []).filter(
    (m) => m.status === "active",
  );
  const userStated = activeItems.filter(
    (m) => m.provenance === "user_stated" || m.provenance === "user_confirmed",
  );
  const otherMem = activeItems.filter(
    (m) => m.provenance !== "user_stated" && m.provenance !== "user_confirmed",
  );

  if (userStated.length > 0) {
    slots.push({
      key: "memory_user_stated",
      label: "memory(user_stated|user_confirmed)",
      text: userStated.map(renderMemoryItem).join("\n"),
      priority: 700,
      droppable: true,
    });
  }

  if (input.mode === "replay_mode" && input.recent_turns && input.recent_turns.length > 0) {
    slots.push({
      key: "recent_turns",
      label: "recent_turns",
      text: renderTurns(input.recent_turns),
      priority: 500,
      droppable: true,
    });
  }

  if (otherMem.length > 0) {
    // Within other memory, sort so lower confidence drops first.
    const sorted = [...otherMem].sort((a, b) => b.confidence - a.confidence);
    slots.push({
      key: "memory_other",
      label: "memory(other)",
      text: sorted.map(renderMemoryItem).join("\n"),
      priority: 300,
      droppable: true,
    });
  }

  if (input.inactive_project_context) {
    slots.push({
      key: "inactive_project_context",
      label: "inactive_project_context",
      text: input.inactive_project_context,
      priority: 200,
      droppable: true,
    });
  }

  if (input.verbose_transcript) {
    slots.push({
      key: "verbose_transcript",
      label: "verbose_transcript",
      text: input.verbose_transcript,
      priority: 100,
      droppable: true,
    });
  }

  return { mode: input.mode, slots };
}

function renderMemoryItem(m: MemoryItemSlot): string {
  return `- (${m.provenance}, conf=${m.confidence.toFixed(2)}) ${m.content}`;
}

function renderTurns(turns: readonly TurnSlot[]): string {
  return turns.map((t) => `[${t.role}@${t.created_at}] ${t.content_redacted}`).join("\n");
}
