# Content Scaffolding

Content files in this folder will be copied for all users (old and new) on the server startup.

1. You **must** create an `index.json` file in `/default/scaffold` for it to work. The syntax is the same as for default content.
2. All file paths should be relative to `/default/scaffold`, the use of subdirectories is allowed.
3. Scaffolded files are copied first, so they override any of the default files (presets/settings/etc.) that have the same file name.

## Example

```json
[
    {
        "filename": "themes/Midnight.json",
        "type": "theme"
    },
    {
        "filename": "backgrounds/city.png",
        "type": "background"
    },
    {
        "filename": "characters/Charlie.png",
        "type": "character"
    }
]
```

## Utopinn release content

This directory is the operator-owned namespace for release content —
`default/content/` is the upstream SillyTavern asset list and should not
gain operator entries again (that path is how the stale `default_*` card
leaked into new accounts).

Current declarations:

- `characters/我没想当掌门啊.png` (`type: character`) — the release starter
  card, seeded into every account's `characters/` by `checkForNewContent`.

Scaffold can only carry what `CONTENT_TYPES` maps to a single file target
(characters, backgrounds, themes, presets, worlds, ...). It **cannot**
carry a CardApp asset tree — `card-apps/<name>/` is a directory payload
with no content type, so the `_seed/` pool (`<dataRoot>/_seed/`, see
`src/services/seed-content.js`) keeps owning the CardApp tree and the
world-book JSON. To swap the starter card: replace the PNG here (and in
`_seed/` for its companion assets); never re-add a `default_*` entry to
`default/content/index.json`.
