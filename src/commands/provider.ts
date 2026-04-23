// Personal Agent P0 — /provider command.
//
// PRD §11.6 / §11.7: P0 supports claude only. Any other request
// returns `not_enabled` without switching provider.

export interface ProviderSwitchArgs {
  readonly requested: string;
}

export interface ProviderSwitchResult {
  readonly active: "claude";
  readonly accepted: boolean;
  readonly message: string;
}

export function switchProvider(args: ProviderSwitchArgs): ProviderSwitchResult {
  const req = args.requested.trim().toLowerCase();
  if (req === "claude" || req === "") {
    return { active: "claude", accepted: true, message: "provider: claude" };
  }
  return {
    active: "claude",
    accepted: false,
    message: `provider '${args.requested}' not_enabled — P0 supports claude only`,
  };
}
