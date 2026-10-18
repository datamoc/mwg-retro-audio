# Repository Guidelines

## Project Structure & Module Organization

This package provides historical sound-chip emulation and music playback in pure TypeScript using native Web Audio.

- `src/chips/`: synthesizers, chip emulation, and hardware profiles.
- `src/formats/` and `src/players/`: file parsers and playback engines.
- `src/driver/`: Web Audio output and offline rendering; `src/sfx/`: sound effects.
- `src/mwg/`: optional integration with `@datamoc/mwg`.
- `tests/`: automated tests, helpers, and `fixtures/` reference data.
- `docs/`: architecture and format specifications; start with `docs/ORGANISATION.md`.
- `tools/`: listening and ROM-analysis utilities. `vendor/hatari-ym/` is a separately licensed package. `dist/` contains build output.

## Build, Test, and Development Commands

Use Node.js 20.19 or newer. Run commands from the package root:

- `npm install`: install dependencies; the development dependency on `@datamoc/mwg` expects a sibling `../mwg` checkout.
- `npm run check`: type-check source and tests without emitting files.
- `npm test`: run all tests using Node’s test runner through `tsx`.
- `npm run build`: emit ES modules and TypeScript declarations into `dist/`.
- `npm run format:check`: check formatting; `npm run format` applies it to source and tests.

## Coding Style & Naming Conventions

Follow strict TypeScript and ES module conventions. Use tabs with width four, single quotes, trailing commas, and a 120-column print width, as configured in `.prettierrc.json`. Keep unused declarations out of changes. Follow nearby naming: PascalCase classes and class files such as `TrackerPlayer.ts`, camelCase functions and variables. Expose public APIs through the relevant `index.ts` entry point. Edit source rather than generated `dist/` files.

## Testing Guidelines

Name tests `tests/*.test.ts` and use `node:test` with Node assertions. Add focused regression cases for parser, chip, timing, or rendering changes; use synthetic format inputs or documented reference fixtures. Preserve PAL/NTSC timing and clock behavior. No coverage threshold is configured. Run type checks, tests, build, and formatting checks before submitting.

## Commit & Pull Request Guidelines

This folder has no accessible Git history, so no existing commit convention can be established. Use concise, imperative commit subjects describing the affected component. PRs should explain behavior changes, link relevant issues, list validation results, and document fidelity limitations in `CONFORMANCE.md` when applicable.

## Licensing & Assets

Preserve MPL-2.0 notices and the separate GPL boundary around `vendor/hatari-ym/`. Do not add proprietary sample ROMs or ROM-derived samples. Document fixture provenance and licensing.

## Model Choice

Always try the cheapest model that can do the job: Haiku for Claude, Luna for OpenAI. By default use Sonnet; ask Opus for advice when a decision is hard; use Haiku for simple, mechanical tasks (renames, one-line fixes, searches, formatting).
