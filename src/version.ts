/**
 * Kept in its own module so it can be imported without side effects.
 *
 * `cli.ts` runs `main()` at load and exits the process, so importing anything
 * from it — as a test reading the version would — terminates the importer.
 *
 * Reading package.json at runtime would need a path that resolves from both
 * `src/` and `dist/`, so this is a literal instead. A test asserts it matches
 * package.json, because a published `--version` that lies is worse than none.
 */
export const VERSION = '0.1.0'
