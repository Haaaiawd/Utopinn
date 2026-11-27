// Launcher bucketing — pure decision layer for the right-rail launcher
// (Workbench.tsx). Kept DOM-free so node --test can pin the grouping
// contract (type-stripped import, same as lib/mobileShell.ts).
//
// Buckets, in render order:
//   cardapp   — panels the *current card* provides; gated by the card's
//               card_app manifest (hasCardApp=false → empty, plus a soft
//               empty state is rendered by the caller).
//   pinned    — first-party core panels promoted to a permanent
//               recommendation slot. Registration order is kept on
//               purpose: the section is editorial ("these are the core
//               entries"), not usage-driven — freq shuffling here would
//               make the recommendation unstable.
//   system    — the rest of the catalog, re-sorted by usage frequency
//               (openPanel bumps 'utopinn.wb.freq'; no record → score -1
//               sinks to the back, keeping registration order).
//   suggested — third-party contrib escape hatch.
// 'hidden' never enters any bucket (transient host panels reachable
// only via openPanel).
import type { PanelTypeContribution } from '../../kernel/contributions';
// Explicit .ts: node --test type-stripping resolves relative imports by
// exact specifier (vite/tsc handle it via allowImportingTsExtensions).
import { panelFreqScore, type PanelFreq } from './panelFreq.ts';

export interface LauncherBuckets {
    cardItems: PanelTypeContribution[];
    pinnedItems: PanelTypeContribution[];
    sysItems: PanelTypeContribution[];
    suggested: PanelTypeContribution[];
}

export function bucketLauncherPanels(
    contribs: readonly PanelTypeContribution[],
    opts: {
        /** Whether the current chat's card declares a card_app manifest. */
        hasCardApp: boolean;
        /** Search predicate; contribs failing it are dropped from every bucket. */
        match: (c: PanelTypeContribution) => boolean;
        /** Usage map from readPanelFreq(); drives system-bucket ordering only. */
        freqMap?: Record<string, PanelFreq>;
    },
): LauncherBuckets {
    const { hasCardApp, match, freqMap = {} } = opts;
    const cardItems = hasCardApp ? contribs.filter((c) => c.category === 'cardapp' && match(c)) : [];
    const pinnedItems = contribs.filter((c) => c.category === 'pinned' && match(c));
    const sysItems = contribs
        .filter((c) => (c.category ?? 'system') === 'system' && match(c))
        .map((c, i) => ({ c, i, s: panelFreqScore(freqMap[c.type]) }))
        .sort((a, b) => (b.s - a.s) || (a.i - b.i))
        .map((x) => x.c);
    const suggested = contribs.filter((c) => c.category === 'suggested' && match(c));
    return { cardItems, pinnedItems, sysItems, suggested };
}
