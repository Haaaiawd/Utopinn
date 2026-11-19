# TASK-033b — State Sidecar Reroute Report (2026-11-19)

Browser-side reroute of the three legacy state sidecar families onto the
`/api/utopinn/state/{chat,char,preset}/*` surface landed by 9caa2eb
(`apps/server/src/plugins/utopinn-library.js:1099-1779`). Closes the
`browser-legacy-calls-inventory-2026-11-19.md` "state sidecars … KEEP until
sidecar routes land" holdout.

## Verdict: 20/20 call sites rerouted, zero KEEP

Every legacy `/api/{chats,characters,presets}/state/*` call in `public/` now
hits the utopinn route. Nothing in the state family needed a legacy
fallback — the utopinn handlers are the same code (they `import` the target
resolvers, namespace normalizers, patch appliers and error mappers straight
from `endpoints/{chats,characters,presets}.js`), so request fields, response
envelopes and status codes are identical by construction.

## Adapter shape

Route prefixes are exported once from
`apps/server/public/scripts/state-resource.js:8-10`
(`UTOPINN_CHAT_STATE_ROUTE` / `UTOPINN_CHAR_STATE_ROUTE` / `UTOPINN_PRESET_STATE_ROUTE`,
each with a `TASK-033 reroute` comment documenting the mapping). Call sites
concatenate the verb (`+ '/patch'` etc.) — same single-fact-source pattern as
the 9caa2eb `utopinnChatRoute` adapters.

### Mapping table

| Family | Legacy path | New path | Call shape |
|---|---|---|---|
| chat_state | GET/POST `/api/chats/state/get` | GET/POST `/api/utopinn/state/chat/get` | query: `is_group`('true'/'false') + `id` or `avatar_url`+`file_name`(+`char_name`), `namespace`, `account` — identical keys |
| | POST `/api/chats/state/patch` | POST `/api/utopinn/state/chat/patch` | body {...target, namespace, operations} -> {ok, applied, created}; 409 conflict / 400 invalid |
| | POST `/api/chats/state/delete` | POST `/api/utopinn/state/chat/delete` | body {...target, namespace} -> {ok, deleted:true} |
| char_state | GET/POST `/api/characters/state/get` | GET/POST `/api/utopinn/state/char/get` | query `avatar` (or `avatar_url`) + `namespace` + `account`; `getQueryCharacterAvatar` account check identical |
| | POST `/api/characters/state/set` | POST `/api/utopinn/state/char/set` | body {avatar_url, namespace, data} -> {ok}; 404 on missing card; same `validateAvatarUrlMiddleware` |
| | POST `/api/characters/state/patch` | POST `/api/utopinn/state/char/patch` | -> {ok, applied, created}; 409/400/404 mapping identical |
| | POST `/api/characters/state/delete` | POST `/api/utopinn/state/char/delete` | -> {ok, deleted} |
| preset_state | GET/POST `/api/presets/state/get` | GET/POST `/api/utopinn/state/preset/get` | query `apiId`+`name`+`namespace`+`account` |
| | POST `/api/presets/state/patch` | POST `/api/utopinn/state/preset/patch` | body {apiId, name, namespace, operations} -> {ok, applied, created}; 409/400 via same `mapStatePatchError` |
| | POST `/api/presets/state/delete` | POST `/api/utopinn/state/preset/delete` | -> {ok, deleted} |
| | POST `/api/presets/state/delete-all` | POST `/api/utopinn/state/preset/delete-all` | -> {ok, deleted:<count>} |
| | POST `/api/presets/state/rename` | POST `/api/utopinn/state/preset/rename` | body {apiId, oldName, newName} -> {ok, renamed}; 409 collision |

## Call sites changed

### apps/server/public/script.js (12 sites + import at :216)
- :3377 restoreDeletedCharacterSnapshot — fetch /api/characters/state/set -> UTOPINN_CHAR_STATE_ROUTE + '/set'
- :12375 invalidatePresetStateRequestCache — invalidate path -> PRESET + '/get'
- :12393 invalidateAllPresetStateRequestCache — invalidate path -> PRESET + '/get'
- :12429 invalidateChatStateRequestCache — invalidate path -> CHAT + '/get'
- :13224 getChatStateBatch — readStateEnvelope -> CHAT + '/get'
- :13322 patchChatState — fetch -> CHAT + '/patch'
- :13476 deleteChatState — fetch -> CHAT + '/delete'
- :13553 getPresetStateBatch — readStateEnvelope -> PRESET + '/get'
- :13649 patchPresetState — fetch -> PRESET + '/patch'
- :13804 deletePresetState — fetch -> PRESET + '/delete'
- :13847 deleteAllPresetState — fetch -> PRESET + '/delete-all'
- :13892 renamePresetStateTarget — fetch -> PRESET + '/rename'

### apps/server/public/scripts/extensions.js (8 sites + import at :14)
- :2246 getCharacterState — readStateEnvelope -> CHAR + '/get'
- :2287 setCharacterState — fetch -> CHAR + '/set'
- :2294, :2348, :2463, :2539 — invalidateStateResources -> CHAR + '/get'
  (success paths of set/patch/delete and the updateCharacterState retry loop)
- :2341 patchCharacterState — fetch -> CHAR + '/patch'
- :2397 getCharacterStateBatch — readStateEnvelope -> CHAR + '/get'
- :2532 deleteCharacterState — fetch -> CHAR + '/delete'

### Doc/prose updates (accuracy only, no code path)
- scripts/extensions/card-app/context.js:423 — persistence path comment -> /api/utopinn/state/chat/
- scripts/extensions/character-editor-assistant/studio/ai-chat.js:1624,1797,1902 — assistant prompt docs -> /api/utopinn/state/chat/

## Request/response alignment notes

- **target fields**: `resolveChatStateTarget` already emits {is_group, id}
  for groups and {is_group:false, avatar_url, file_name, char_name} for
  characters — exactly what the shared `resolveChatStateRepoKey` consumes on
  both surfaces; `char_name` is passed through and ignored identically.
  Preset targets {apiId, name} and char targets {avatar_url} are likewise
  verbatim fields the utopinn handlers read.
- **namespace normalization**: client `normalizeStateNamespace` (lowercase,
  [^a-z0-9._-] -> _, 96-char cap) matches the server-side normalizers, which
  are the same imported functions on both surfaces.
- **ETag / private reads**: `readStateEnvelope` GETs go through
  `sendJsonResource` on both surfaces (same helper, same
  `Cache-Control: private, no-cache, max-age=1` + ETag over
  account+resource+text, same ?account=<handle> gate via
  `loadResourceBootstrap`). Resource identifiers
  (`chat-state:…`, `character-state:…`, `preset-state:…`) are computed from
  the same target fields, so ETag values are byte-identical for equal state.
- **Cache coherence**: read and invalidate now share the utopinn path, so
  `invalidateStateResources` prefix/exact matching against in-flight
  `readResourceJson` URLs is preserved. The local `chatStateRequestCache` /
  `presetStateRequestCache` generation maps are path-agnostic — untouched.
- **Response envelopes**: {ok,data} reads, {ok,applied,created} patches,
  {ok,deleted} deletes, {ok,renamed} renames, {ok} set — all consumed exactly
  as before; the 409-conflict retry loops in `patchChatState` /
  `patchPresetState` / `updateCharacterState` rely on status codes that map
  identically.
- **Per-family asymmetries preserved**: char `set` (whole-state overwrite)
  rerouted to its utopinn twin; preset `delete-all`/`rename` rerouted to
  the preset-only utopinn verbs; the `updateCharacterState` docstring's
  "/state/set endpoint requires an object" remark stays true on the new
  surface (same `_.isObjectLike && !Array` check).

## Deliberately NOT changed

- **POST …/state/get-batch routes** (all three families): exist on both
  surfaces but the browser never used them — `getChatStateBatch` /
  `getPresetStateBatch` / `getCharacterStateBatch` fan out ETag-cached
  single GETs instead. No client change needed; the utopinn twins remain
  available.
- **Legacy routes stay mounted** server-side (by design — dispatcher falls
  through); other consumers (CLI, tests, external tools) unaffected.
- `user.js:3152,3155` chat_states=/preset_states= — stats display strings
  from /api/users/stats, not endpoint calls.

## Verification

- `node --check` clean on all 5 edited files.
- grep sweep: zero remaining /api/{chats,characters,presets}/state/ fetch or
  read/invalidate references outside TASK-033 comments.

## Remaining risks

- No browser-side E2E run — contract equivalence is argued from shared
  handler code (single fact source), not re-observed over HTTP. A smoke pass
  of get/patch/delete on one chat, one card and one preset would close the
  loop.
- Server-side `request.user` plumbing on the plugin dispatcher is exercised
  by these routes the same way as the already-rerouted resource reads;
  group-chat state targets (`is_group:true` + `id`) take the
  `resolveChatStateRepoKey` group branch — shared code, not separately
  smoke-tested here.
- ai-chat.js prompt text now names the utopinn path; if the assistant
  extension ever emits direct legacy fetches they still work (legacy
  mounted), so worst case is a doc inconsistency, not breakage.
