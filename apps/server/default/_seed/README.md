# Release seed pool (`default/_seed/`)

The image-side counterpart of `<dataRoot>/_seed/` — the operator-owned
skeleton user home whose entries are copied into new accounts at
registration by `seedUserDirectories` (`src/services/seed-content.js`).

`default/scaffold/` can only carry **single files** declared in its
`index.json`; it cannot express a directory payload. Pool payloads live
here instead.

At server boot, `provisionSeedPool` materializes this tree into
`<dataRoot>/_seed/` **only when that directory does not already exist**:

- fresh install → the shipped payload becomes the pool, so the starter
  card's companions reach every new account — the bootstrap
  `default-user` that `initUserStorage` creates on first boot (this is
  what makes single-user mode work, where nothing ever registers) and
  each later registration;
- existing `_seed` (operator-provisioned) → the image copy is skipped
  wholesale — never merged, never overwritten. An upgrade therefore does
  **not** change what existing deployments seed; see the remediation
  notes in `default/scaffold/README.md`.

## Current payloads

- `card-apps/我没想当掌门啊/` — the starter card's CardApp asset tree.
  The scaffold PNG declares `extensions.card_app` without embedded
  `files`, so the mount 404s (`card_app_assets_missing`) without this.
- `worlds/我没想当掌门啊｜世界书 v1.8.json` — the world book the card's
  `extensions.world` names.

The character PNG itself is deliberately NOT here — it is declared once
in `default/scaffold/index.json`. Keep exactly one declaration per
artifact.

## Layout contract

Pool subdirectories are `USER_DIRECTORY_TEMPLATE` values (`card-apps`,
`worlds`, `characters`, ...): `_seed/<template-dir>/<entry>` lands at
`<dataRoot>/<handle>/<template-dir>/<entry>` when the account is
created. Pool copies never overwrite existing account files and reserve
space through the same quota accounting as user writes
(`checkUserStorageQuota`).

To backfill existing accounts after changing the pool:

```bash
node scripts/seed-accounts.js --dataRoot <dataRoot> [--handle <handle>] [--dry-run]
```
