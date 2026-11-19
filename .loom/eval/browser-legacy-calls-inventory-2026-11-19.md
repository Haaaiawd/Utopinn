# Browser Legacy-Call Inventory — 2026-11-19
Recon spec for TASK-033: every call in `apps/server/public/` that still hits a LEGACY endpoint (anything not under `/api/uberge/*`), with proposed uberge replacement or KEEP rationale.

## Uberge route table (source: `apps/server/src/plugins/uberge-*.js`)

| Surface | Routes |
|---|---|
| uberge-library.js | `GET /api/uberge/characters`, `GET /api/uberge/characters/:charDir`, `GET/PUT/DELETE/PATCH /api/uberge/characters/:charDir/chats/:chatName`, `GET /api/uberge/characters/:charDir/chats`, `POST .../chats/:chatName/rename`, `POST .../chats/:chatName/messages`, `GET/PUT/DELETE /api/uberge/presets[/:name]?apiId=`, `GET/PUT/DELETE /api/uberge/worlds[/:name]`, `GET /api/uberge/personas`, `PUT/DELETE /api/uberge/personas/:avatar`, `GET/PATCH /api/uberge/settings` (PATCH whitelist: `power_user`,`extension_settings` only), `GET /api/uberge/secrets`, `PUT /api/uberge/secrets/:key`, `DELETE /api/uberge/secrets/:key/:id` |
| uberge-generate.js | `POST /api/uberge/generate`, `POST /api/uberge/preview`, `GET /api/uberge/jobs`, `GET /api/uberge/jobs/:id` |
| uberge-mvu.js | `POST /api/uberge/mvu/settle`, `POST /api/uberge/mvu/resettle`, `GET /api/uberge/mvu/state`, `POST /api/uberge/mvu/panel/render` |
| uberge-th.js | `POST /api/uberge/th/call` |
| uberge-script.js | `POST /api/uberge/script/run` |
| uberge-import.js | `POST /api/uberge/import/preview`, `POST /api/uberge/import/commit` |
| uberge-data.js | `POST /api/uberge/backup`, `POST /api/uberge/lan/offer`, `POST /api/uberge/lan/import`, `POST /api/uberge/import/scan-st` (+UDP discovery) |
| uberge-plugins.js | `GET /api/uberge/plugins`, `POST /api/uberge/plugins/:id/{enable,disable,reload}` (kernel plugins, NOT ST extensions) |
| uberge-diag.js | `GET /api/uberge/_kernel` |
| uberge-delivery.js | WS upgrade `/api/ws-delivery` (new surface, not legacy) |

Already migrated: `scripts/openai.js:4388` `fetch('/api/uberge/generate')` (TASK-030 chat-domain generation). `ws-delivery.js:149` `new WebSocket(.../api/ws-delivery)` is the new channel. Everything below is legacy.

## (a) Summary — call sites per domain

| Domain | Sites | Reroutable | KEEP |
|---|---|---|---|
| chats (`/api/chats/*`) | 42 | 17 | 25 (group/state/import/export/search/recent/merge/split) |
| characters (`/api/characters/*`) | 43 | 9 | 34 |
| presets (`/api/presets/*`) | 13 | 6 | 7 (state sidecars + restore) |
| settings (`/api/settings/*` + `/api/bootstrap*`) | 11 | 2 | 9 |
| personas (`/api/avatars/*`) | 5 | 0 | 5 |
| secrets (`/api/secrets/*`) | 8 | 3 | 5 |
| world-info (`/api/worldinfo/*`) | 9 | 7 | 2 |
| users (`/api/users/*`) | ~63 | 3 | ~60 |
| generation-support (backends/jobs/abort/ws-ticket/horde/sd/tts…) | ~120 | 0 | ~120 (KEEP by design) |
| misc resources (groups/themes/moving-ui/quick-replies/backgrounds/image-metadata/images/files/sprites/media/backups/extensions/skills/card-app/vector/tokenizers/translate/search/extra/plugins/docs/debug/stats/request-inspector/system/content/data-maid/sync/ping/bootstrap/credits) | ~190 | 0 | ~190 |
| **TOTAL** | **~504** | **~47** | **~457** |

## Detailed inventory by domain

### CHATS — `/api/chats/*` (script.js)
- 3027 `fetch('/api/chats/get')` → GET `/api/uberge/characters/:charDir/chats/:chatName`
- 3054, 3199, 14918 `fetch('/api/chats/save')` → partial: PUT create + POST messages + PATCH; no whole-doc save route — needs save-shape route or client fan-out
- 3354 `fetch('/api/chats/delete')` → DELETE `.../chats/:chatName`
- 3698 `fetch('/api/chats/group/get')` → KEEP (no group surface)
- 3718, 12006, 12849, 15162 `fetch('/api/chats/get')` → uberge GET chat
- 12048, 14431, 14868 `fetch('/api/chats/patch')` → PATCH uberge
- 12247, 13052, 13149, 13302 `.../state/*` → KEEP (chat_state sidecar)
- 14191, 14392, 14636 `.../group/*` → KEEP
- 14251 `fetch('/api/chats/append')` → POST `.../messages`
- 14674 `fetch('/api/chats/meta/patch')` → PATCH uberge (header ops)
- 16588 endpoint var → fetch at 16597; character half reroutable
- 16806 `/api/chats/search` → KEEP
- 17719 `/api/chats/import` → KEEP (chat import ≠ uberge import kinds)
- 19435 `/api/chats/rename` → POST `.../rename`
- 20515 `/api/chats/export` → KEEP

group-chats.js — all KEEP (no group surface). welcome-screen.js:931 `/api/chats/recent` KEEP. bookmarks.js:516 group/save KEEP. chat-merge-split.js merge/split/group-info KEEP.

### CHARACTERS — `/api/characters/*`
- 2938 `fetch('/api/characters/all')` → GET `/api/uberge/characters`
- 3007, 3448, 16643 `fetch('/api/characters/chats')` → GET `.../chats`
- 22316 `fetch('/api/characters/get')` → GET `/api/uberge/characters/:charDir`
- 19273 `fetch('/api/characters/import')` → import/preview + commit
- create/edit/delete/state/merge-attributes/export → KEEP (no uberge write surface)
- resource-read.js fields/projection → KEEP (etag-granular)
- bookmarks.js:113, chat-merge-split.js:133 `/api/characters/chats` → uberge chats list

### PRESETS — `/api/presets/*`
- openai.js:7643 delete → DELETE uberge
- preset-persistence.js:19 save → PUT uberge
- preset-manager.js:1463 delete → uberge DELETE; 1652 restore → KEEP
- named-resource-read.js:73 list, 79 get → uberge GETs
- script.js presets/state/* ×5 → KEEP

### SETTINGS — `/api/settings/*`
- 15668 `'/api/settings/get'` → GET `/api/uberge/settings` (verify stripped-field consumers)
- 15841/15778 `/api/settings/bootstrap` + `/api/bootstrap` → KEEP (compound envelope, needs decomposition)
- 16131 `/api/settings/patch` → PATCH uberge — CAVEAT whitelist only `power_user`+`extension_settings`; audit callers
- 16143 `/api/settings/save` → KEEP
- settings-resource-read.js fields/field → KEEP; user.js snapshots ×4 → KEEP

### PERSONAS — `/api/avatars/*`
- personas.js 175 get, 1294/1327/3246 upload, 2226 delete → KEEP (image ops; metadata split → uberge `/personas`)

### SECRETS — `/api/secrets/*`
- secrets.js:300 settings, 318 view → GET `/api/uberge/secrets`
- 395 write → PUT `/api/uberge/secrets/:key`
- 424 delete → DELETE `/api/uberge/secrets/:key/:id`
- 456 read, 478 find, 503 rotate, 528 rename → KEEP
- 1226/1292 credits → KEEP (provider proxies)

### WORLD-INFO — `/api/worldinfo/*`
- world-info.js:3079,5529 list → GET `/api/uberge/worlds`
- 8172 patch → KEEP or get+PUT
- 8182 edit → PUT `/api/uberge/worlds/:name`
- 8439 delete → DELETE `/api/uberge/worlds/:name`
- 10668 import → `/api/uberge/import/preview`+`commit` (kind=world)
- named-resource-read.js:128/134, script.js:22284 → uberge GETs

### USERS — `/api/users/*` (~63 sites, ~60 KEEP)
- Reroutable: user.js:713 backup → `/api/uberge/backup`; 977 lan-migration/offer → `/api/uberge/lan/offer`; 1035 lan-migration/import → `/api/uberge/lan/import`
- All admin/auth/snapshot/log/chunked-upload/sync sites → KEEP

### GENERATION-SUPPORT — KEEP by design (~120 sites)
jobs/active|status|cancel, events-stream, ws-ticket, abort, request-inspector, all LLM dispatch endpoints (kobold/koboldhorde/text-completions/novelai/horde/sd/tts/embed/caption/multimodal-models), EventSource wrappers.

### MISC — all KEEP (~190 sites)
groups CRUD, themes/moving-ui/quick-replies, backgrounds, image-metadata, images/files, sprites, media/backups, extensions mgmt (≠ /api/uberge/plugins), skills, card-app file IO, vectors/embeddings, tokenizers, translate, search, extras, server plugins, docs/debug/stats/system, content/data-maid, sync, provider credits, TTS providers, image/video gen, non-/api (version, api/ping relative!, csrf-token, thumbnail).

## (d) Top-10 highest-impact reroute targets

1. **`POST /api/chats/get`** — script.js ×5 + 16588-variant; chat-read hot path → `GET /api/uberge/characters/:charDir/chats/:chatName`
2. **`POST /api/characters/all`** — script.js:2938; boot library load → `GET /api/uberge/characters`
3. **`POST /api/chats/save`** — script.js ×3; saveChatConditional funnel → PUT create + POST `.../messages` + PATCH (design decision needed)
4. **`POST /api/characters/chats`** — script.js ×3 + bookmarks + merge-split → `GET .../chats`
5. **`POST /api/settings/get` + `/api/settings/bootstrap`** — boot → `GET /api/uberge/settings` (bootstrap needs decomposition)
6. **`POST /api/chats/patch` + `meta/patch`** — ×4 → `PATCH uberge`
7. **`POST /api/chats/append`** — 14251 → `POST .../messages` (gen-id dedup aligned)
8. **presets save|delete|list|get** → uberge presets CRUD
9. **worldinfo list|get|edit|delete** → uberge worlds CRUD
10. **chats delete|rename** → DELETE + POST `.../rename`

Honorable: secrets view/write/delete → uberge secrets; characters/get → uberge GET; characters/worldinfo import → import routes; users backup/lan-migration → uberge data routes.

## Migration notes / caveats
- **PATCH /api/uberge/settings whitelist** (`power_user`,`extension_settings` only) — audit callers patching other sections
- **`/api/chats/save` no 1:1 route** — highest-risk reroute; needs design decision (whole-doc route vs fan-out)
- **State sidecars** (`chat_state`/`char_state`/`preset_state`) — zero uberge coverage, KEEP until sidecar routes land
- **Group chats + groups** — no uberge surface at all
- **Persona avatar images** vs persona metadata — split reroute
- **`/api/extensions/*` ≠ `/api/uberge/plugins`** — different surfaces, do not cross-wire
- **`fetch('api/ping')` at script.js:2126** — relative URL, easy to miss in greps
