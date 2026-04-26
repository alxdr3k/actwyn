# Generated Docs

Generated docs are derived from code, schema, migrations, or config.

**Do not edit generated docs by hand.** If a generated doc is wrong,
fix the generator (or the underlying source); do not patch the
output.

There are no generation commands defined in this repo today, so this
directory is currently empty. When generation lands, this README
will record:

- Which command produces each generated file.
- Where the source of the generation lives (script path, migration
  file, etc.).
- When the doc is regenerated (CI step, pre-commit hook, manual
  command).

## Potential future generated docs

These are candidates only — none are committed to.

- **DB schema reference** — generated from `migrations/*.sql` plus
  the `schema.migrations.<NNN>` keys in `settings`.
- **API reference** — exported types from `src/providers/types.ts`,
  `src/telegram/types.ts`, and any future external interface.
- **Provider capability matrix** — generated from the Claude
  adapter and stub providers in `src/providers/`.
- **Judgment enum / reference** — once `judgment_*` migrations
  exist, generate the enum and field reference.
- **Module graph** — generated from `tsc --listFiles` plus an
  import-walker, so an agent can cheaply skim how `src/` modules
  reference each other.

When you add a generator, update `docs/DOCUMENTATION.md` "What to
update when" with the rule for keeping the output fresh.
