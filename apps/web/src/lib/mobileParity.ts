/**
 * Mobile/desktop feature-parity contract — the executable registry.
 *
 * Every form-factor decision point in src/ (any `isMobile` read that picks
 * a branch: && / || / ternary / if / negation) must be declared here, keyed
 * by file + a substring that appears on the decision line. The contract
 * test (tests/mobile-parity.test.mjs) scans the source and fails when:
 *   - a flagged decision line matches no entry   → new silent asymmetry
 *   - an entry's sites no longer exist in source → stale declaration
 *
 * Each entry states what mobile gets instead (`mobile`) and why the split
 * is intentional (`why`) — so "feature missing on mobile" is always a
 * written decision, never an accident. Size/density/presence adaptations
 * do NOT live here: they belong to the CSS twin (mob: variant +
 * .desk-only/.mob-only reading html[data-vp]) and carry no JS branch.
 *
 * The scanner excludes this file by name (its `sites` substrings
 * necessarily quote the flag identifier).
 */

export type ForkKind =
    | 'mechanism' /* the flag plumbing itself (definition, data-vp writer) */
    | 'layout'    /* whole-shell/view structural fork */
    | 'behavior'  /* different action/target on mobile */
    | 'gate';     /* feature intentionally unavailable, with honest state */

export interface ParityFork {
    id: string;
    /** File relative to apps/web/src. */
    file: string;
    /** Substrings — each must appear on a flagged decision line in `file`. */
    sites: string[];
    kind: ForkKind;
    /** What mobile users get instead (the parity answer). */
    mobile: string;
    /** Why this is an intentional split, not a missing feature. */
    why: string;
}

export const MOBILE_PARITY: readonly ParityFork[] = [
    {
        id: 'shell.root-fork',
        file: 'App.tsx',
        sites: ['{isMobile ? ('],
        kind: 'layout',
        mobile: 'MobileFrame: drawer nav + bottom-sheet workbench + full-bleed stage',
        why: 'The single intentional shell split. Everything below it is shared via contribution points (view/panel/ctbar), so domains never fork twice.',
    },
    {
        id: 'shell.data-vp',
        file: 'App.tsx',
        sites: ['dataset.vp = isMobile ?'],
        kind: 'mechanism',
        mobile: 'Same flag mirrored to html[data-vp] for the CSS twin (mob:, desk-only/mob-only)',
        why: 'Mechanism, not a fork — lets CSS express the same truth incl. ?vp= forced mode.',
    },
    {
        id: 'workbench.float-collapse',
        file: 'App.tsx',
        sites: ['!isMobile || floatOrder.length === 0'],
        kind: 'behavior',
        mobile: 'Floating panels re-dock into the sheet on flip; hint toast explains',
        why: 'Floating windows have no metaphor in the sheet model; state is preserved via openTabs.',
    },
    {
        id: 'panel.open-sheet-snap',
        file: 'App.tsx',
        sites: ["if (isMobile) setSheetSnap('half')", 'setSheetSnap(registry.find'],
        kind: 'behavior',
        mobile: 'openPanel raises the bottom sheet (half; cardapp goes full)',
        why: 'Same panels, different host: sheet snap replaces "open workbench column". Content identical.',
    },
    {
        id: 'workbench.select-tab-cardapp',
        file: 'App.tsx',
        sites: ['if (isMobile && registry.find'],
        kind: 'behavior',
        mobile: 'Selecting a cardapp tab bumps sheet to full (iframe needs real height)',
        why: 'Density adaptation of the same panel set, not a feature difference.',
    },
    {
        id: 'nav.gotoView-domain-map',
        file: 'App.tsx',
        sites: ['isMobile && !deep'],
        kind: 'behavior',
        mobile: "plugins→settings sheet, studio→hub, home→chat; deep nav (deep=true) bypasses the map",
        why: 'Mobile has one full-page surface per domain; mapping keeps every ViewId reachable. Deep navigation still lands.',
    },
    {
        id: 'workbench.detach',
        file: 'App.tsx',
        sites: ['if (isMobile) return;'],
        kind: 'gate',
        mobile: 'detachPanel no-ops; the sheet IS the detached surface (drag handle / snap = same affordance)',
        why: 'Floating windows cannot exist under the sheet model. Entry button hidden via desk-only, not a silent loss — equivalent reach exists.',
    },
    {
        id: 'workbench.expand-fill',
        file: 'App.tsx',
        sites: ['wbExpand && workbenchOpen && !isMobile'],
        kind: 'gate',
        mobile: 'Sheet full snap gives the same "panel takes over the stage" affordance',
        why: 'Expanding a dock column is meaningless without a dock column. Button hidden via desk-only.',
    },
    {
        id: 'overlay.settings-fork',
        file: 'App.tsx',
        sites: ['{!isMobile && <SettingsModal'],
        kind: 'layout',
        mobile: 'MobileSettingsSheet (full page) inside MobileFrame; SettingsSheet (modal) on desktop — both render the shared SettingsTabContent',
        why: 'Shell fork only — the test asserts both overlays consume SettingsTabContent, so tabs can never drift apart.',
    },
    {
        id: 'launcher.autofocus',
        file: 'components/shell/Workbench.tsx',
        sites: ['autoFocus={!isMobile}'],
        kind: 'behavior',
        mobile: 'No autofocus — keyboard would fight the sheet open animation; focus still works on tap',
        why: 'Input method difference, not a feature difference.',
    },
    {
        id: 'panel.float-windows',
        file: 'components/shell/Workbench.tsx',
        sites: ['const floating = !isMobile'],
        kind: 'gate',
        mobile: 'Floating window concept absent by design — one sheet instead of N floating cards',
        why: 'Same as workbench.detach: deliberate host-model difference with an equivalent reach.',
    },
    {
        id: 'panels.studio-nav-close-sheet',
        file: 'components/panels/SpecPanels.tsx',
        sites: ["if (s.isMobile) s.setSheetSnap('closed')"],
        kind: 'behavior',
        mobile: 'Worldbook deep-link first closes the sheet so the studio page is actually visible',
        why: 'Navigation sequencing, not a feature difference — the destination is identical.',
    },
    {
        id: 'theater.portrait-hint',
        file: 'features/stagepack.tsx',
        sites: ['!immersive || !s.isMobile'],
        kind: 'behavior',
        mobile: '"Rotate device" hint only sampled in mobile immersive mode',
        why: 'Desktop has no orientation to rotate — the hint would be noise.',
    },
    {
        id: 'theater.orientation-lock',
        file: 'features/stagepack.tsx',
        sites: ['if (!s.isMobile) return;'],
        kind: 'behavior',
        mobile: 'screen.orientation.lock("landscape") attempted; failure falls back to the rotate hint',
        why: 'Orientation API only exists on mobile shells.',
    },
    {
        id: 'theater.auto-fullscreen',
        file: 'features/stagepack.tsx',
        sites: ['if (s.isMobile) enterFs();'],
        kind: 'behavior',
        mobile: 'Immersive stage tries real fullscreen on mount (browser may refuse without gesture → overlay fallback)',
        why: 'Desktop theatre stays windowed by design; fullscreen is the mobile immersion path.',
    },
    {
        id: 'stage.sidebar-btn',
        file: 'components/stage/CenterStage.tsx',
        sites: ['(s.isMobile || !s.sidebarOpen)', 's.isMobile ? s.setMobileDrawer'],
        kind: 'behavior',
        mobile: 'Same "get the sidebar back" affordance → opens drawer instead of toggling the column',
        why: 'One button, two hosts. Visibility rule (show when sidebar absent) unchanged.',
    },
    {
        id: 'stage.composer-pop-anchor',
        file: 'components/stage/StageFrame.tsx',
        sites: ['s.isMobile ? 122 : 126'],
        kind: 'behavior',
        mobile: 'Composer popovers anchor 4px lower (88/122 vs 92/126 base offsets)',
        why: 'Density tuning of the same popovers — expressed in JS because the value also varies with QR space.',
    },
    {
        id: 'stage.token-fmt',
        file: 'components/stage/StageFrame.tsx',
        sites: ['lastTokens.toLocaleString'],
        kind: 'behavior',
        mobile: 'Compact k-format ("12.3k") for the context meter',
        why: 'Same information, denser rendering for a narrower chip.',
    },
    {
        id: 'admin.view-gate',
        file: 'components/views/admin.tsx',
        sites: ['if (s.isMobile)'],
        kind: 'gate',
        mobile: 'Honest empty state (mob.view.noMobile + back-to-chat action) — never a silent missing page',
        why: 'Instance administration is deliberately desktop-scope; the gate is declared and user-visible.',
    },
    {
        id: 'home.layout-fork',
        file: 'components/views/SpecViews.tsx',
        sites: ['if (s.isMobile)'],
        kind: 'layout',
        mobile: 'Mobile home gallery variant: menu button + hero + cover masonry (same cards, same actions)',
        why: 'Whole-view chrome differs per spec; the card set and tap behavior are shared.',
    },
];

/** ViewIds the mobile domain map reroutes — asserted against App.tsx gotoView. */
export const MOBILE_VIEW_MAP: Readonly<Record<string, string>> = {
    plugins: 'settings sheet (openSettings)',
    studio: 'hub',
    home: 'chat',
};
