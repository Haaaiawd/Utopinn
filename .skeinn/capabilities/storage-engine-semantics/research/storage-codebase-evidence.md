# Codebase Grounding: Storage Engine Transaction Semantics

Verified directly against on-disk source files (2026-11-21):

- `apps/server/src/storage/README.md` (L1-345): Documents the four-engine architecture (`FsEngine`, `SqliteEngine`, `MysqlEngine`, `PgEngine`) behind unified Engine/Transaction/Repository layers (`ChatRepo`, `SettingsRepo`, `PresetRepo`, `WorldInfoRepo`, `NamedDocRepo`, `GroupRepo`, `StatsRepo`), explicit FS non-rollback caveat, cross-engine coarse metric differences (`chat_size`, `updatedAt`), disk-resident blob boundaries, `preset_states` intentional lack of FK mirroring FS orphan tolerance, PG collation warnings, and single-process `MigrationRunner` constraints.
- `apps/server/src/storage/engines/fs-engine.js` & `sqlite-engine.js`: `FsEngine.withTransaction` provides in-process serialization without rollback; `SqliteEngine` uses WAL + FK on + `BEGIN IMMEDIATE` real ACID transactions.
- `apps/server/src/storage/repositories/world-info-repo.js` (L23-74): Empirical classification of `createIfAbsent` atomicity across FS/SQLite (serialized per-handle critical section) vs MySQL/PostgreSQL (default isolation `ON DUPLICATE KEY` / `ON CONFLICT` last-writer-wins with dual `created:true`).
- `.skeinn/design/v2-stack-decisions.md` (§存储/数据库): Product stratification — `fs` = ST-compatible default, `sqlite` = deployment recommendation, `mysql`/`postgres` = large-deployment escape hatches.
