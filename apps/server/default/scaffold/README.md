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
with no content type, so the CardApp tree and the world-book JSON ship in
`default/_seed/` (see its README), which `provisionSeedPool` materializes
into `<dataRoot>/_seed/` on a fresh install. An existing
`<dataRoot>/_seed/` is never merged or overwritten — operator pools win.

To swap the starter card: replace the PNG here (and in `default/_seed/`
for its companion assets); never re-add a `default_*` entry to
`default/content/index.json`.

## Swapping caveat: existing accounts do not re-receive

Delivery is tracked **by filename** in each account's `content.log`, and
an existing file is never overwritten. Replacing the PNG under the same
name therefore only reaches accounts that never received it — accounts
that already got the old card keep it. Options:

- Ship the new card under a **new filename** (a new artifact is logged
  and delivered everywhere; remove the old declaration/file so new
  installs don't get both), or
- Per account, delete the delivered file and its `content.log` line, then
  restart — the next content check re-seeds it:

  ```bash
  rm '<dataRoot>/<handle>/characters/我没想当掌门啊.png'
  sed -i '/我没想当掌门啊\.png/d' '<dataRoot>/<handle>/content.log'
  ```

Companion payloads (`card-apps/`, `worlds/` entries) follow the pool's
own rule — never overwrite — so backfill only adds what is missing:

```bash
node scripts/seed-accounts.js --dataRoot <dataRoot> --dry-run   # preview
node scripts/seed-accounts.js --dataRoot <dataRoot>             # apply
```

If the CardApp tree itself changed, remove the account's stale
`card-apps/<name>/` first, then run the backfill.
