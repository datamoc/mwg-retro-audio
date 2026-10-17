# Proposal: self-contained asset packages for MWL

Status: **proposal** for the mwg maintainers. Nothing in mwg is changed by this package; everything below is additive
and uses what `@datamoc/mwg-retro-audio` already provides (the MWA container and the `SfxDefinition` data model).

## 1. The problem

Today an MWL file is a declarative description (`unit_type`, `map`, `event`, `item`...) that refers to its media by
**logical path** (`image: "units/scout.png"`, `music: "music/town.mp3"`). The audio and graphics live elsewhere, in a
folder the game packages in its own way (`assets.json` lists the paths, "the game's own asset step decides how to
resolve or package them"). That is right for a game author. It is awkward for the players of a game who want to
**exchange a piece of content**: a character, a piece of music, a sound set, a whole scenario. They would have to
ship a folder, keep the paths consistent, and trust whatever is in it.

The goal: **one file that carries a complete asset**, typically _a character with its picture, its game statistics,
its animations, its scripts, its sound effects and its music_, that a player can send to another player and drop into
the game for a scenario.

## 2. Principles

1. **Additive.** Existing `.mwl` files and the current build (`game-data.ts`, `i18n.json`, `assets.json`) keep working.
2. **One file, declarative first.** A package is an MWL document plus the binary media it refers to, in a single
   compressed container. Data is data; the only executable part is explicit, small and sandboxed (section 6).
3. **Retro audio is data, not files.** Music is an MWA register log (or a tracker module), sound effects are
   `SfxDefinition` objects written in MWL itself. Both are tiny and diffable.
4. **Safe to share.** A package declares what it contains and what it asks for; the game decides. Nothing is
   executed or fetched at install time.
5. **Mergeable.** Contents get a namespace so two characters from two authors never collide.

## 3. New tags (all optional)

| Tag            | Purpose                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package`      | root descriptor: id, version, author, license, `requires` (mwg and engine versions, capabilities)                                                     |
| `asset`        | one embedded binary: `id`, `kind` (`image` `audio` `music` `font` `data`), `path` inside the package, `mime`, `sha256`, optional `license` / `source` |
| `character`    | a `unit_type` plus everything that makes it a character: `portrait`, `sprite`, `animations`, `sounds`, `theme`, `scripts` (below)                     |
| `animation`    | named timeline over a sprite sheet: `frames`, `fps`, `loop`, `events` (frame -> sound / hook)                                                         |
| `sound_effect` | an `SfxDefinition` (`chip`, `priority`, `retrigger`, voices with curves) described as MWL children, compiled to data                                  |
| `music`        | `src: "asset-id"` (an MWA or tracker file), `loop`, `region`, `fallback` (a streamed file for platforms without the engine)                           |
| `script`       | a named hook (`on`, `hook`) whose body is a restricted expression language (section 6), not arbitrary JavaScript                                      |
| `import`       | merge another package or file under a namespace                                                                                                       |

Existing tags can keep their `music:` / `sound:` / `image:` attributes: the value is simply allowed to be either a
path (today) or an **asset id** of the same package, resolved first.

## 4. A character in one file

```json5
[
  {
    tag: "package",
    id: "marta-the-ranger",
    version: "1.0.0",
    author: "someone",
    license: "CC-BY-4.0",
    requires: { mwg: ">=0.42", retroAudio: ">=0.1", capabilities: ["audio"] },
  },
  { tag: "asset", id: "portrait", kind: "image", path: "media/portrait.png" },
  { tag: "asset", id: "sheet",    kind: "image", path: "media/sheet.png" },
  { tag: "asset", id: "theme",    kind: "music", path: "media/theme.mwa" },        // YM / VGM / NSF ... converted to MWA

  {
    tag: "character",
    id: "marta",
    name: _("Marta"),
    portrait: "portrait",
    sprite: { image: "sheet", frame: [32, 48] },
    hitpoints: 28, movement: 5, attack: 7, defense: 3,        // the stats of a unit_type
    theme: "theme",
    animations: {
      idle:   { frames: [0, 1, 2, 1], fps: 4, loop: true },
      shoot:  { frames: [8, 9, 10, 11], fps: 12, events: { 10: { sound: "arrow" } } },
    },
    sounds: { hurt: "ouch", arrow: "arrow" },
    scripts: ["on-low-health"],
  },

  {
    tag: "sound_effect", id: "arrow", chip: "ym2149", priority: 5, retrigger: "restart", length: 18,
    voices: [{ channel: "any", pitch: { start: 96, step: -2.4, min: 48 }, volume: { start: 15, step: -0.8, min: 0 } }],
  },
  {
    tag: "sound_effect", id: "ouch", chip: "sn76489", priority: 6, retrigger: "restart",
    voices: [{ channel: 3, noisePeriod: { values: [2, 2, 3, 3, 4] }, volume: { start: 15, step: -1.5, min: 0 } }],
  },

  {
    tag: "script", id: "on-low-health", on: "damage",
    when: "self.hp <= self.maxHp / 4",
    do: [{ tag: "play", sound: "ouch" }, { tag: "message", text: _("Marta grits her teeth.") }],
  },
]
```

That one file is what a player sends to another player. The compiled result of the existing pipeline stays what it is
(`game-data.ts` with the unit, `assets.json` listing what the game must serve); the audio data is handed to the
engine.

## 5. The package file (`.mwp`)

A package is a single file, the same compression story as MWA (DEFLATE, decoded by the engine's own `inflateRaw`):

```
magic       "MWP1"
u32         directory size
directory   JSON (UTF-8, DEFLATE): { "entries": [ { "path", "size", "packed", "offset", "sha256" } ], "main": "content.mwl" }
entries     each entry DEFLATE-compressed, back to back
```

- `main` is the MWL document above (normally `content.mwl`); every `asset.path` resolves inside the package.
- `sha256` of every entry is checked on load; a mismatch refuses the package.
- Limits are declared and enforced by the loader: total size, number of entries, image dimensions, longest
  audio (defaults a game can raise).

Proposed commands, in the style of the existing `npm run mwl`:

```
npm run mwl -- pack   my-character/ -o marta.mwp     # folder with content.mwl + media/  ->  package
npm run mwl -- unpack marta.mwp -o my-character/     # back to an editable folder
npm run mwl -- verify marta.mwp                       # hashes, limits, schema, requested capabilities
npm run mwl -- build  marta.mwp -o generated/         # as today, from a package instead of a folder
```

`mwl pack` converts audio on the way in: a `.ym` `.vgm` `.nsf` `.sid` `.dro` `.imf` `.cmf` is stored as MWA (via
`convertToMwa`), a tracker module or a WAV is stored as is. One universal audio format inside the package means one
code path in the game.

## 6. Scripts without arbitrary code

Sharing content between players means running content from people one does not know. So:

- **Declarative first.** Most behaviour is data: animations, `events`, `sounds`, stat tables, triggers (`on` + `when` +
  `do`).
- `when` / `do` use the **existing MWL event vocabulary** (`message`, `give`, `play`, `set`...) and a small **pure
  expression language** (arithmetic, comparison, field access on declared objects, no loops, no I/O, bounded steps).
- A package that needs real code must say so in `requires.capabilities` (e.g. `"script"`), and the game is free to
  refuse it, to run it in a worker with no network, or to accept only packages signed by a key the player trusts.
- Hooks already exposed by mwg (the AI hook references of `mwl-content`) remain the route for code that the _game
  author_ ships; packages never override them.

## 7. Namespacing and merge

On load, every id of a package gets the prefix of `package.id`: `marta-the-ranger:marta`, `marta-the-ranger:arrow`.
References inside the package are written without the prefix and resolved locally first. A scenario that wants Marta
writes `unit: "marta-the-ranger:marta"`. Two versions of the same package can coexist by id + version, and a save
game records the exact `id@version#sha256` it used.

## 8. How the audio engine plugs in

| In the package                            | At runtime                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset kind: "music"` (MWA)               | `loadFile(bytes)` -> `RetroPlayer`; `retroBusLoader` hands it to `AudioBus` as a rendered, looped `LoadedTrack`, or `retroPlayableFactory` feeds mwg's `Music` crossfades                            |
| `sound_effect`                            | compiled to an `SfxDefinition` in a `SfxBank`; played by `SfxEngine.play(id)` on the same chip as the music (channel stealing, priority) or rendered once with `renderSfx` into a buffer for `Sound` |
| `asset kind: "audio"` (WAV, VOC, tracker) | `loadFile`, same path                                                                                                                                                                                |
| `fallback` stream                         | used when the page cannot run the engine                                                                                                                                                             |

The engine is used through the adapters in `@datamoc/mwg-retro-audio/mwg`; no change to mwg's audio classes is needed
for the first step. The only mwg-side additions are the MWL tags and the `pack` / `verify` commands.

## 9. Compatibility and migration

- A file without any new tag compiles exactly as today.
- `music: "music/town.mp3"` keeps meaning a path; `music: "theme"` resolves to the package asset `theme` if it
  exists, else to the path. A lint rule flags the ambiguity.
- The `assets.json` produced by `build` lists the package assets with their logical ids, so the game's own asset step
  still has the last word on where the bytes live.
- Versioning: `package.requires.mwg` and `retroAudio` use semver ranges; the loader refuses a package that asks for
  more than the running game provides, with a readable message.

## 10. Open questions for the maintainers

1. Container: reuse the ZIP central directory (every tool can open it) or the small `MWP1` directory above? ZIP is
   friendlier, `MWP1` simpler to hash and to read without libraries.
2. Where should the expression language live (mwg core or a separate package) and which of the existing event
   tags are safe in a shared package?
3. Signatures: a detached signature file, or a field of the directory? Who keeps the list of trusted keys?
4. Do packages carry **localisation** (`_()` strings with their `i18n.json` slice) so that a shared character speaks
   the player's language? The proposal assumes yes: strings go through the same extraction.
5. Should `character` stay a macro that expands to `unit_type` + `animation` + `sound_effect` + `script`, or become a
   first-class compiled type with its own generated table?
