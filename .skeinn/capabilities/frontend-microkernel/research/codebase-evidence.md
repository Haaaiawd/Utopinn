# Codebase Grounding: apps/web Frontend Microkernel

Verified directly against on-disk source files (2026-11-21):

- `apps/web/src/kernel/kernel.ts` (L1-105): Cordis-semantics microkernel implementing `Feature {name, inject?, apply(ctx)}`, `FeatureCtx` (`add`, `effect`, `inject`, `provide`, `get`, `locale`), `Waiter` queue with `flush()` on `provide()`, scoped cleanup collection (`scope()` collect), and Cordis fiber semantics (already-applied consumers do not auto-rollback on `unprovide`).
- `apps/web/src/kernel/contributions.ts` (L1-92): Eight typed contribution slots (`nav.rail`, `view`, `sidebar.tree`, `stage.form`, `panel.type`, `renderer`, `ctbar.chat`, `locale`) synchronized 1:1 with server `KNOWN_SLOTS` (`apps/server/src/plugins/utopinn-plugins.js:48-52`).
- `apps/web/src/kernel/registry.ts`: Single source of truth reactive registry subscribed via `useSyncExternalStore`.
- `apps/web/src/features/contrib.tsx` (L1-143): `/api/utopinn/ui/contrib` server hydration reconciling `panel.type` entries inside the owning feature scope via dispose + re-register (zero secondary override store).
- `apps/web/src/features/panels.tsx`: Honest `wired` flags, zero-prop `Body` components reading `useShell()`, and `panelParams[type]` pass-through.
