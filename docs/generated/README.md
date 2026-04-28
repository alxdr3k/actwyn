# Generated Docs

Generated docs are derived from code, schema, migrations, or config.

**Do not edit generated docs by hand.** If a generated doc is wrong,
fix the generator (or the underlying source); do not patch the
output.

## Active generators

| Output | Command | Source | When to regenerate |
|--------|---------|--------|--------------------|
| `schema.md` | `bun run docs:generate:schema` | `migrations/*.sql` | Any time a migration is added or modified |

`scripts/generate-schema-doc.ts` is the generator for `schema.md`. Run it and
commit the output in the same commit as the migration change.

## Potential future generated docs

These are candidates — not yet committed to.

- **API reference** — exported types from `src/providers/types.ts`,
  `src/telegram/types.ts`, and any future external interface.
- **Provider capability matrix** — generated from the Claude
  adapter and stub providers in `src/providers/`.
- **Module graph** — generated from `tsc --listFiles` plus an
  import-walker, so an agent can cheaply skim how `src/` modules
  reference each other.

When you add a generator, add a row to the table above and update
`docs/DOCUMENTATION.md` "What to update when".
