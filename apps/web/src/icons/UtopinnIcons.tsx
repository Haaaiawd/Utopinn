/**
 * Utopinn · Brand Iconography System v3 (U馆 品牌图标系统 · 主导航精修版)
 * Total: 43 icons (P0: 10, P1: 9, P2: 6, P3: 6, Secondary 1.5px: 12) + Portal Spark Logo
 * Built-in Aliases: gear -> settings, gitFork -> branch
 * Spec: 24x24 viewBox | core strokeWidth=1.85px | round caps/joins | #FF6B5B structural accents
 * Selected panelRight Concept: 方案 A · 推门光缝 (Portal Slit)
 */
import React from 'react';

export type UtopinnCanonicalIconName =
  | 'home'
  | 'chat'
  | 'studio'
  | 'plugins'
  | 'settings'
  | 'panelRight'
  | 'slash'
  | 'arrowUp'
  | 'menu'
  | 'user'
  | 'feather'
  | 'messages'
  | 'sparkles'
  | 'dice'
  | 'music'
  | 'brain'
  | 'persona'
  | 'branch'
  | 'wand'
  | 'compass'
  | 'bookmark'
  | 'flame'
  | 'database'
  | 'layers'
  | 'sliders'
  | 'shield'
  | 'bookOpen'
  | 'radio'
  | 'code'
  | 'import'
  | 'cpu'
  | 'copy'
  | 'undo'
  | 'search'
  | 'close'
  | 'plus'
  | 'check'
  | 'more'
  | 'chevronDown'
  | 'arrowRight'
  | 'trash'
  | 'pencil'
  | 'list';

export type UtopinnIconAlias = 'gear' | 'gitFork';
export type UtopinnIconName = UtopinnCanonicalIconName | UtopinnIconAlias;

const ICON_ALIAS_MAP: Record<UtopinnIconAlias, UtopinnCanonicalIconName> = {
  gear: 'settings',
  gitFork: 'branch',
};

export interface UtopinnIconProps extends React.SVGProps<SVGSVGElement> {
  name: UtopinnIconName;
  active?: boolean;
  size?: number;
  strokeWidth?: number;
}

export const UtopinnLogo: React.FC<{ size?: number; className?: string }> = ({
  size = 28,
  className = '',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="8 5 106 106"
    width={size}
    height={size}
    fill="none"
    className={className}
    aria-label="Utopinn"
  >
    <path
      d="M 24.5 44 L 24.5 71 A 25.5 25.5 0 0 0 75.36 73.67"
      stroke="currentColor"
      strokeWidth={14.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M 0 -24.2 C 3.1 -24.2 3.8 -9.6 6.7 -6.7 C 9.6 -3.8 24.2 -3.1 24.2 0 C 24.2 3.1 9.6 3.8 6.7 6.7 C 3.8 9.6 3.1 24.2 0 24.2 C -3.1 24.2 -3.8 9.6 -6.7 6.7 C -9.6 3.8 -24.2 3.1 -24.2 0 C -24.2 -3.1 -9.6 -3.8 -6.7 -6.7 C -3.8 -9.6 -3.1 -24.2 0 -24.2 Z"
      fill="#FF6B5B"
      transform="translate(81 36.5) rotate(14)"
    />
  </svg>
);

export const UtopinnIcon: React.FC<UtopinnIconProps> = ({
  name,
  active = false,
  size = 24,
  strokeWidth = 1.85,
  className = '',
  style,
  ...rest
}) => {
  const sw = strokeWidth;
  const resolvedName: UtopinnCanonicalIconName =
    name in ICON_ALIAS_MAP ? ICON_ALIAS_MAP[name as UtopinnIconAlias] : (name as UtopinnCanonicalIconName);
  const isGear = resolvedName === 'settings';

  const mergedStyle: React.CSSProperties = isGear
    ? {
        transition: 'transform 0.44s cubic-bezier(0.34, 1.56, 0.64, 1)',
        transform: active ? 'rotate(90deg)' : 'rotate(0deg)',
        transformOrigin: 'center',
        ...style,
      }
    : { ...style };

  const renderGlyph = () => {
    switch (resolvedName) {
    case 'home':
      return active ? (
        <>
          <path d="M 2.8 10.4 L 11.15 4.15 C 11.65 3.78 12.35 3.78 12.85 4.15 L 21.2 10.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 5.0 8.9 V 18.5 C 5.0 19.38 5.72 20.1 6.6 20.1 H 7.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 16.4 20.1 H 17.4 C 18.28 20.1 19.0 19.38 19.0 18.5 V 8.9" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 9.3 20.4 V 13.7 A 2.7 2.7 0 0 1 14.7 13.7 V 20.4 Z" fill="#FF6B5B"/>
        </>
      ) : (
        <>
          <path d="M 2.8 10.4 L 11.15 4.15 C 11.65 3.78 12.35 3.78 12.85 4.15 L 21.2 10.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 5.0 8.9 V 18.5 C 5.0 19.38 5.72 20.1 6.6 20.1 H 9.1 V 14.0 A 2.9 2.9 0 0 1 14.9 14.0 V 20.1 H 17.4 C 18.28 20.1 19.0 19.38 19.0 18.5 V 8.9" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'chat':
      return active ? (
        <>
          <path d="M 4.9 16.3 C 3.85 14.95 3.3 13.25 3.3 11.35 C 3.3 6.85 7.1 3.6 12.0 3.6 C 16.9 3.6 20.7 6.85 20.7 11.35 C 20.7 15.85 16.9 19.1 12.0 19.1 C 10.55 19.1 9.15 18.8 7.9 18.25 L 3.8 19.75 L 4.9 16.3 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 0 -4.6 C 0.64 -4.6 0.69 -1.89 1.29 -1.29 C 1.89 -0.69 4.6 -0.64 4.6 0 C 4.6 0.64 1.89 0.69 1.29 1.29 C 0.69 1.89 0.64 4.6 0 4.6 C -0.64 4.6 -0.69 1.89 -1.29 1.29 C -1.89 0.69 -4.6 0.64 -4.6 0 C -4.6 -0.64 -1.89 -0.69 -1.29 -1.29 C -0.69 -1.89 -0.64 -4.6 0 -4.6 Z" fill="#FF6B5B" transform="translate(12.2 11.35) rotate(14)"/>
        </>
      ) : (
        <>
          <path d="M 4.9 16.3 C 3.85 14.95 3.3 13.25 3.3 11.35 C 3.3 6.85 7.1 3.6 12.0 3.6 C 16.9 3.6 20.7 6.85 20.7 11.35 C 20.7 15.85 16.9 19.1 12.0 19.1 C 10.55 19.1 9.15 18.8 7.9 18.25 L 3.8 19.75 L 4.9 16.3 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'studio':
      return active ? (
        <>
          <path d="M 5.0 18.2 V 5.8 C 5.0 4.65 5.9 3.8 7.05 3.8 H 10.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 19.0 6.2 V 16.3 H 7.05 C 5.9 16.3 5.0 17.15 5.0 18.2 C 5.0 19.25 5.9 20.1 7.05 20.1 H 18.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 8.2 4.0 V 16.1" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" opacity="0.45"/>
          <path d="M 13.0 2.6 H 16.8 C 17.18 2.6 17.5 2.92 17.5 3.3 V 12.2 C 17.5 12.7 16.92 12.98 16.54 12.64 L 14.9 11.2 L 13.26 12.64 C 12.88 12.98 12.3 12.7 12.3 12.2 V 3.3 C 12.3 2.92 12.62 2.6 13.0 2.6 Z" fill="#FF6B5B"/>
        </>
      ) : (
        <>
          <path d="M 5.0 18.2 V 5.8 C 5.0 4.65 5.9 3.8 7.05 3.8 H 18.1 C 18.65 3.8 19.0 4.2 19.0 4.75 V 16.3 H 7.05 C 5.9 16.3 5.0 17.15 5.0 18.2 C 5.0 19.25 5.9 20.1 7.05 20.1 H 18.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 8.2 4.0 V 16.1" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" opacity="0.45"/>
        </>
      );

    case 'plugins':
      return active ? (
        <>
          <rect x="3.5" y="3.5" width="6.8" height="6.8" rx="2.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="3.5" y="13.7" width="6.8" height="6.8" rx="2.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="13.7" y="13.7" width="6.8" height="6.8" rx="2.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="13.9" y="3.5" width="6.6" height="6.6" rx="1.8" fill="#FF6B5B" transform="rotate(45 17.2 6.8)"/>
        </>
      ) : (
        <>
          <rect x="3.5" y="3.5" width="6.8" height="6.8" rx="2.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="3.5" y="13.7" width="6.8" height="6.8" rx="2.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="13.7" y="13.7" width="6.8" height="6.8" rx="2.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="14.3" y="3.9" width="5.8" height="5.8" rx="1.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" transform="rotate(45 17.2 6.8)"/>
        </>
      );

    case 'settings':
      return active ? (
        <>
          <path d="M 9.2 5.4 L 10.3 3.4 C 10.55 2.95 11.0 2.7 11.5 2.7 H 12.5 C 13.0 2.7 13.45 2.95 13.7 3.4 L 14.8 5.4 C 15.35 5.65 15.85 5.95 16.3 6.3 L 18.6 6.25 C 19.12 6.23 19.6 6.5 19.86 6.95 L 20.36 7.82 C 20.62 8.27 20.62 8.82 20.35 9.26 L 19.15 11.2 C 19.22 11.73 19.22 12.27 19.15 12.8 L 20.35 14.74 C 20.62 15.18 20.62 15.73 20.36 16.18 L 19.86 17.05 C 19.6 17.5 19.12 17.77 18.6 17.75 L 16.3 17.7 C 15.85 18.05 15.35 18.35 14.8 18.6 L 13.7 20.6 C 13.45 21.05 13.0 21.3 12.5 21.3 H 11.5 C 11.0 21.3 10.55 21.05 10.3 20.6 L 9.2 18.6 C 8.65 18.35 8.15 18.05 7.7 17.7 L 5.4 17.75 C 4.88 17.77 4.4 17.5 4.14 17.05 L 3.64 16.18 C 3.38 15.73 3.38 15.18 3.65 14.74 L 4.85 12.8 C 4.78 12.27 4.78 11.73 4.85 11.2 L 3.65 9.26 C 3.38 8.82 3.38 8.27 3.64 7.82 L 4.14 6.95 C 4.4 6.5 4.88 6.23 5.4 6.25 L 7.7 6.3 C 8.15 5.95 8.65 5.65 9.2 5.4 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="12" cy="12" r="4.0" fill="#FF6B5B"/>
        </>
      ) : (
        <>
          <path d="M 9.2 5.4 L 10.3 3.4 C 10.55 2.95 11.0 2.7 11.5 2.7 H 12.5 C 13.0 2.7 13.45 2.95 13.7 3.4 L 14.8 5.4 C 15.35 5.65 15.85 5.95 16.3 6.3 L 18.6 6.25 C 19.12 6.23 19.6 6.5 19.86 6.95 L 20.36 7.82 C 20.62 8.27 20.62 8.82 20.35 9.26 L 19.15 11.2 C 19.22 11.73 19.22 12.27 19.15 12.8 L 20.35 14.74 C 20.62 15.18 20.62 15.73 20.36 16.18 L 19.86 17.05 C 19.6 17.5 19.12 17.77 18.6 17.75 L 16.3 17.7 C 15.85 18.05 15.35 18.35 14.8 18.6 L 13.7 20.6 C 13.45 21.05 13.0 21.3 12.5 21.3 H 11.5 C 11.0 21.3 10.55 21.05 10.3 20.6 L 9.2 18.6 C 8.65 18.35 8.15 18.05 7.7 17.7 L 5.4 17.75 C 4.88 17.77 4.4 17.5 4.14 17.05 L 3.64 16.18 C 3.38 15.73 3.38 15.18 3.65 14.74 L 4.85 12.8 C 4.78 12.27 4.78 11.73 4.85 11.2 L 3.65 9.26 C 3.38 8.82 3.38 8.27 3.64 7.82 L 4.14 6.95 C 4.4 6.5 4.88 6.23 5.4 6.25 L 7.7 6.3 C 8.15 5.95 8.65 5.65 9.2 5.4 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    // panelRight variant: 方案 A · 推门光缝 (Portal Slit)
    case 'panelRight':
      return active ? (
        <>
          <path d="M 4.4 19.6 V 8.8 C 4.4 5.9 6.5 4.0 9.4 4.0 H 11.2 C 11.9 4.0 12.4 4.5 12.4 5.2 V 19.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 3.4 19.6 H 13.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 15.0 4.8 C 15.0 4.3 15.48 3.95 15.96 4.08 L 19.1 4.95 C 19.64 5.1 20.0 5.6 20.0 6.16 V 19.1 C 20.0 19.72 19.5 20.2 18.88 20.2 H 15.8 C 15.36 20.2 15.0 19.84 15.0 19.4 V 4.8 Z" fill="#FF6B5B"/>
          <path d="M 0 -3 C 0.42 -3 0.45 -1.23 0.84 -0.84 C 1.23 -0.45 3 -0.42 3 0 C 3 0.42 1.23 0.45 0.84 0.84 C 0.45 1.23 0.42 3 0 3 C -0.42 3 -0.45 1.23 -0.84 0.84 C -1.23 0.45 -3 0.42 -3 0 C -3 -0.42 -1.23 -0.45 -0.84 -0.84 C -0.45 -1.23 -0.42 -3 0 -3 Z" fill="#FFFFFF" transform="translate(17.5 11.8) rotate(14)"/>
        </>
      ) : (
        <>
          <path d="M 5.6 19.6 V 9.8 A 6.4 6.4 0 0 1 18.4 9.8 V 19.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 3.6 19.6 H 20.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 14.8 11.2 V 14.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'slash':
      return active ? (
        <>
          <path d="M 13.0 3.8 H 7.2 C 5.32 3.8 3.8 5.32 3.8 7.2 V 16.8 C 3.8 18.68 5.32 20.2 7.2 20.2 H 16.8 C 18.68 20.2 20.2 18.68 20.2 16.8 V 11.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 14.2 7.6 L 9.8 16.4" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 0 -3.8 C 0.53 -3.8 0.57 -1.55 1.06 -1.06 C 1.55 -0.57 3.8 -0.53 3.8 0 C 3.8 0.53 1.55 0.57 1.06 1.06 C 0.57 1.55 0.53 3.8 0 3.8 C -0.53 3.8 -0.57 1.55 -1.06 1.06 C -1.55 0.57 -3.8 0.53 -3.8 0 C -3.8 -0.53 -1.55 -0.57 -1.06 -1.06 C -0.57 -1.55 -0.53 -3.8 0 -3.8 Z" fill="#FF6B5B" transform="translate(18.6 5.4) rotate(14)"/>
        </>
      ) : (
        <>
          <path d="M 13.0 3.8 H 7.2 C 5.32 3.8 3.8 5.32 3.8 7.2 V 16.8 C 3.8 18.68 5.32 20.2 7.2 20.2 H 16.8 C 18.68 20.2 20.2 18.68 20.2 16.8 V 11.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 14.2 7.6 L 9.8 16.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'arrowUp':
      return active ? (
        <>
          <circle cx="12" cy="12" r="9.6" fill="#FF6B5B"/>
          <path d="M 12 16.4 V 7.8" stroke="#FFFFFF" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 8.2 11.4 L 12 7.6 L 15.8 11.4" stroke="#FFFFFF" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="8.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 16.0 V 8.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 8.5 11.5 L 12 8.0 L 15.5 11.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'menu':
      return active ? (
        <>
          <path d="M 3.8 6.5 H 9.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="12.2" y="4.85" width="8.0" height="3.3" rx="1.65" fill="#FF6B5B"/>
          <path d="M 3.8 12.0 H 20.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 3.8 17.5 H 14.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      ) : (
        <>
          <path d="M 3.8 6.5 H 15.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 3.8 12.0 H 20.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 3.8 17.5 H 13.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'user':
      return active ? (
        <>
          <circle cx="12" cy="8.1" r="3.45" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 4.8 19.6 C 4.8 15.8 7.9 13.7 12.0 13.7 C 16.1 13.7 19.2 15.8 19.2 19.6 C 19.2 20.1 18.8 20.4 18.3 20.4 H 5.7 C 5.2 20.4 4.8 20.1 4.8 19.6 Z" fill="#FF6B5B"/>
        </>
      ) : (
        <>
          <circle cx="12" cy="8.1" r="3.45" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 4.8 19.8 C 4.8 15.9 7.9 13.8 12.0 13.8 C 16.1 13.8 19.2 15.9 19.2 19.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'feather':
      return active ? (
        <>
          <path d="M 19.8 4.1 C 15.6 4.1 11.4 5.9 8.9 9.3 L 6.4 16.3 L 13.4 13.8 C 16.9 11.3 19.8 8.3 19.8 4.1 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 14.6 9.3 L 4.6 18.3" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 0 -3.5 C 0.49 -3.5 0.52 -1.44 0.98 -0.98 C 1.44 -0.52 3.5 -0.49 3.5 0 C 3.5 0.49 1.44 0.52 0.98 0.98 C 0.52 1.44 0.49 3.5 0 3.5 C -0.49 3.5 -0.52 1.44 -0.98 0.98 C -1.44 0.52 -3.5 0.49 -3.5 0 C -3.5 -0.49 -1.44 -0.52 -0.98 -0.98 C -0.52 -1.44 -0.49 -3.5 0 -3.5 Z" fill="#FF6B5B" transform="translate(11.4 18.6) rotate(14)"/>
        </>
      ) : (
        <>
          <path d="M 19.8 4.1 C 15.6 4.1 11.4 5.9 8.9 9.3 L 6.4 16.3 L 13.4 13.8 C 16.9 11.3 19.8 8.3 19.8 4.1 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 14.6 9.3 L 4.6 18.3" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'messages':
      return active ? (
        <>
          <path d="M 4.4 16.8 C 3.7 15.8 3.3 14.6 3.3 13.3 C 3.3 10.1 6.1 7.6 9.6 7.6 C 13.1 7.6 15.9 10.1 15.9 13.3 C 15.9 16.5 13.1 19.0 9.6 19.0 C 8.5 19.0 7.45 18.75 6.55 18.3 L 3.8 19.4 L 4.4 16.8 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 10.4 7.6 C 11.1 5.1 13.3 3.7 15.9 3.7 C 19.0 3.7 21.1 5.8 21.1 8.6 C 21.1 9.8 20.7 10.9 20.0 11.8 L 20.5 14.2 L 18.0 13.3 C 17.3 13.55 16.6 13.7 15.9 13.7" fill="#FF6B5B" fillOpacity="0.2" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      ) : (
        <>
          <path d="M 4.4 16.8 C 3.7 15.8 3.3 14.6 3.3 13.3 C 3.3 10.1 6.1 7.6 9.6 7.6 C 13.1 7.6 15.9 10.1 15.9 13.3 C 15.9 16.5 13.1 19.0 9.6 19.0 C 8.5 19.0 7.45 18.75 6.55 18.3 L 3.8 19.4 L 4.4 16.8 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 10.4 7.6 C 11.1 5.1 13.3 3.7 15.9 3.7 C 19.0 3.7 21.1 5.8 21.1 8.6 C 21.1 9.8 20.7 10.9 20.0 11.8 L 20.5 14.2 L 18.0 13.3 C 17.3 13.55 16.6 13.7 15.9 13.7" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'sparkles':
      return active ? (
        <>
          <path d="M 0 -6.2 C 0.87 -6.2 0.93 -2.55 1.74 -1.74 C 2.55 -0.93 6.2 -0.87 6.2 0 C 6.2 0.87 2.55 0.93 1.74 1.74 C 0.93 2.55 0.87 6.2 0 6.2 C -0.87 6.2 -0.93 2.55 -1.74 1.74 C -2.55 0.93 -6.2 0.87 -6.2 0 C -6.2 -0.87 -2.55 -0.93 -1.74 -1.74 C -0.93 -2.55 -0.87 -6.2 0 -6.2 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" transform="translate(9.6 13.6) rotate(14)"/>
          <path d="M 0 -4.2 C 0.59 -4.2 0.63 -1.73 1.18 -1.18 C 1.73 -0.63 4.2 -0.59 4.2 0 C 4.2 0.59 1.73 0.63 1.18 1.18 C 0.63 1.73 0.59 4.2 0 4.2 C -0.59 4.2 -0.63 1.73 -1.18 1.18 C -1.73 0.63 -4.2 0.59 -4.2 0 C -4.2 -0.59 -1.73 -0.63 -1.18 -1.18 C -0.63 -1.73 -0.59 -4.2 0 -4.2 Z" fill="#FF6B5B" transform="translate(17.7 6.5) rotate(14)"/>
        </>
      ) : (
        <>
          <path d="M 0 -6.2 C 0.87 -6.2 0.93 -2.55 1.74 -1.74 C 2.55 -0.93 6.2 -0.87 6.2 0 C 6.2 0.87 2.55 0.93 1.74 1.74 C 0.93 2.55 0.87 6.2 0 6.2 C -0.87 6.2 -0.93 2.55 -1.74 1.74 C -2.55 0.93 -6.2 0.87 -6.2 0 C -6.2 -0.87 -2.55 -0.93 -1.74 -1.74 C -0.93 -2.55 -0.87 -6.2 0 -6.2 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" transform="translate(9.6 13.6) rotate(14)"/>
          <path d="M 0 -3.2 C 0.45 -3.2 0.48 -1.32 0.9 -0.9 C 1.32 -0.48 3.2 -0.45 3.2 0 C 3.2 0.45 1.32 0.48 0.9 0.9 C 0.48 1.32 0.45 3.2 0 3.2 C -0.45 3.2 -0.48 1.32 -0.9 0.9 C -1.32 0.48 -3.2 0.45 -3.2 0 C -3.2 -0.45 -1.32 -0.48 -0.9 -0.9 C -0.48 -1.32 -0.45 -3.2 0 -3.2 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" transform="translate(17.7 6.5) rotate(14)"/>
        </>
      );

    case 'dice':
      return active ? (
        <>
          <rect x="4" y="4" width="16" height="16" rx="3.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="8.6" cy="15.4" r="1.35" fill="currentColor"/>
          <circle cx="12" cy="12" r="1.35" fill="currentColor"/>
          <path d="M 0 -3.2 C 0.45 -3.2 0.48 -1.32 0.9 -0.9 C 1.32 -0.48 3.2 -0.45 3.2 0 C 3.2 0.45 1.32 0.48 0.9 0.9 C 0.48 1.32 0.45 3.2 0 3.2 C -0.45 3.2 -0.48 1.32 -0.9 0.9 C -1.32 0.48 -3.2 0.45 -3.2 0 C -3.2 -0.45 -1.32 -0.48 -0.9 -0.9 C -0.48 -1.32 -0.45 -3.2 0 -3.2 Z" fill="#FF6B5B" transform="translate(15.6 8.4) rotate(14)"/>
        </>
      ) : (
        <>
          <rect x="4" y="4" width="16" height="16" rx="3.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="8.6" cy="15.4" r="1.35" fill="currentColor"/>
          <circle cx="12" cy="12" r="1.35" fill="currentColor"/>
          <circle cx="15.4" cy="8.6" r="1.35" fill="currentColor"/>
        </>
      );

    case 'music':
      return active ? (
        <>
          <path d="M 8.1 17.0 V 6.5 L 16.4 4.8 V 15.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="5.8" cy="17.4" r="2.45" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="14.1" cy="15.4" r="3.2" fill="#FF6B5B"/>
          <path d="M 19.6 7.5 A 5.2 5.2 0 0 1 19.6 13.5" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      ) : (
        <>
          <path d="M 8.1 17.0 V 6.5 L 16.4 4.8 V 15.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="5.8" cy="17.4" r="2.45" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="14.1" cy="15.4" r="2.45" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'brain':
      return active ? (
        <>
          <path d="M 12 5.6 C 11.3 4.4 9.9 3.8 8.5 4.0 C 6.6 4.3 5.2 5.9 5.3 7.9 C 4.1 8.8 3.6 10.4 4.0 12.1 C 4.3 13.3 5.0 14.2 5.8 14.8 C 5.5 16.8 6.8 18.8 8.8 19.3 C 10.1 19.6 11.4 19.1 12 18.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 5.6 C 12.7 4.4 14.1 3.8 15.5 4.0 C 17.4 4.3 18.8 5.9 18.7 7.9 C 19.9 8.8 20.4 10.4 20.0 12.1 C 19.7 13.3 19.0 14.2 18.2 14.8 C 18.5 16.8 17.2 18.8 15.2 19.3 C 13.9 19.6 12.6 19.1 12 18.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 5.6 V 7.2 M 12 16.6 V 18.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 0 -3.8 C 0.53 -3.8 0.57 -1.55 1.06 -1.06 C 1.55 -0.57 3.8 -0.53 3.8 0 C 3.8 0.53 1.55 0.57 1.06 1.06 C 0.57 1.55 0.53 3.8 0 3.8 C -0.53 3.8 -0.57 1.55 -1.06 1.06 C -1.55 0.57 -3.8 0.53 -3.8 0 C -3.8 -0.53 -1.55 -0.57 -1.06 -1.06 C -0.57 -1.55 -0.53 -3.8 0 -3.8 Z" fill="#FF6B5B" transform="translate(12 11.9) rotate(14)"/>
        </>
      ) : (
        <>
          <path d="M 12 5.6 C 11.3 4.4 9.9 3.8 8.5 4.0 C 6.6 4.3 5.2 5.9 5.3 7.9 C 4.1 8.8 3.6 10.4 4.0 12.1 C 4.3 13.3 5.0 14.2 5.8 14.8 C 5.5 16.8 6.8 18.8 8.8 19.3 C 10.1 19.6 11.4 19.1 12 18.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 5.6 C 12.7 4.4 14.1 3.8 15.5 4.0 C 17.4 4.3 18.8 5.9 18.7 7.9 C 19.9 8.8 20.4 10.4 20.0 12.1 C 19.7 13.3 19.0 14.2 18.2 14.8 C 18.5 16.8 17.2 18.8 15.2 19.3 C 13.9 19.6 12.6 19.1 12 18.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 5.6 V 18.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'persona':
      return active ? (
        <>
          <circle cx="9.2" cy="8.4" r="3.1" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 3.8 19.2 C 3.8 15.9 6.2 14.1 9.2 14.1 C 12.2 14.1 14.6 15.9 14.6 19.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 16.2 14.5 C 18.6 15.1 20.1 16.8 20.1 19.2" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 0 -3.2 C 0.45 -3.2 0.48 -1.32 0.9 -0.9 C 1.32 -0.48 3.2 -0.45 3.2 0 C 3.2 0.45 1.32 0.48 0.9 0.9 C 0.48 1.32 0.45 3.2 0 3.2 C -0.45 3.2 -0.48 1.32 -0.9 0.9 C -1.32 0.48 -3.2 0.45 -3.2 0 C -3.2 -0.45 -1.32 -0.48 -0.9 -0.9 C -0.48 -1.32 -0.45 -3.2 0 -3.2 Z" fill="#FF6B5B" transform="translate(17.4 8.2) rotate(14)"/>
        </>
      ) : (
        <>
          <circle cx="9.2" cy="8.4" r="3.1" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 3.8 19.2 C 3.8 15.9 6.2 14.1 9.2 14.1 C 12.2 14.1 14.6 15.9 14.6 19.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 14.8 5.6 C 16.4 5.9 17.6 7.1 17.6 8.7 C 17.6 10.2 16.5 11.4 15.0 11.7" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 16.2 14.5 C 18.6 15.1 20.1 16.8 20.1 19.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'branch':
      return active ? (
        <>
          <circle cx="7.2" cy="5.8" r="2.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="7.2" cy="18.2" r="2.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 7.2 8.2 V 15.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 7.2 15.3 C 7.2 12.2 17.0 12.8 17.0 9.8" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="17.0" cy="6.8" r="3.1" fill="#FF6B5B"/>
        </>
      ) : (
        <>
          <circle cx="7.2" cy="5.8" r="2.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="7.2" cy="18.2" r="2.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 7.2 8.2 V 15.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 7.2 15.3 C 7.2 12.2 17.0 12.8 17.0 9.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="17.0" cy="7.0" r="2.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'wand':
      return active ? (
        <>
          <path d="M 4.6 19.4 L 15.0 9.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 11.0 10.2 L 13.8 13.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 0 -4.2 C 0.59 -4.2 0.63 -1.73 1.18 -1.18 C 1.73 -0.63 4.2 -0.59 4.2 0 C 4.2 0.59 1.73 0.63 1.18 1.18 C 0.63 1.73 0.59 4.2 0 4.2 C -0.59 4.2 -0.63 1.73 -1.18 1.18 C -1.73 0.63 -4.2 0.59 -4.2 0 C -4.2 -0.59 -1.73 -0.63 -1.18 -1.18 C -0.63 -1.73 -0.59 -4.2 0 -4.2 Z" fill="#FF6B5B" transform="translate(17.6 6.4) rotate(14)"/>
        </>
      ) : (
        <>
          <path d="M 4.6 19.4 L 15.0 9.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 11.0 10.2 L 13.8 13.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'compass':
      return active ? (
        <>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 10.2 10.2 L 8.1 15.9 L 13.8 13.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 16.1 7.9 L 13.8 13.8 L 10.2 10.2 Z" fill="#FF6B5B" stroke="#FF6B5B" strokeWidth={sw} strokeLinejoin="round"/>
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 15.9 8.1 L 13.7 13.7 L 8.1 15.9 L 10.3 10.3 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'bookmark':
      return active ? (
        <>
          <path d="M 6.2 6.2 C 6.2 4.8 7.3 3.8 8.7 3.8 H 15.3 C 16.7 3.8 17.8 4.8 17.8 6.2 V 19.6 C 17.8 19.6 15.8 16.4 12.0 16.4 C 8.2 16.4 6.2 19.6 6.2 19.6 V 6.2 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="12" cy="9.9" r="2.55" fill="#FF6B5B"/>
        </>
      ) : (
        <>
          <path d="M 6.2 6.2 C 6.2 4.8 7.3 3.8 8.7 3.8 H 15.3 C 16.7 3.8 17.8 4.8 17.8 6.2 V 19.6 C 17.8 19.6 15.8 16.4 12.0 16.4 C 8.2 16.4 6.2 19.6 6.2 19.6 V 6.2 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'flame':
      return active ? (
        <>
          <path d="M 12.3 3.5 C 12.6 7.0 16.8 8.8 18.0 12.2 C 19.0 15.0 17.6 18.6 14.5 19.8 C 11.4 21.0 7.6 19.6 6.3 16.6 C 5.1 13.8 6.3 10.6 8.3 8.8 C 8.4 10.3 9.2 11.2 10.2 11.4 C 9.8 8.4 10.6 5.4 12.3 3.5 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12.1 11.3 C 13.6 12.9 14.6 14.3 14.3 15.9 C 14.1 17.2 13.1 17.9 11.9 17.9 C 10.7 17.9 9.7 16.9 9.7 15.7 C 9.7 14.2 10.8 12.9 12.1 11.3 Z" fill="#FF6B5B"/>
        </>
      ) : (
        <>
          <path d="M 12.3 3.5 C 12.6 7.0 16.8 8.8 18.0 12.2 C 19.0 15.0 17.6 18.6 14.5 19.8 C 11.4 21.0 7.6 19.6 6.3 16.6 C 5.1 13.8 6.3 10.6 8.3 8.8 C 8.4 10.3 9.2 11.2 10.2 11.4 C 9.8 8.4 10.6 5.4 12.3 3.5 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'database':
      return active ? (
        <>
          <path d="M 4.5 6.1 V 17.9 C 4.5 19.34 7.86 20.5 12 20.5 C 16.14 20.5 19.5 19.34 19.5 17.9 V 6.1" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 4.5 12 C 4.5 13.44 7.86 14.6 12 14.6 C 16.14 14.6 19.5 13.44 19.5 12" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <ellipse cx="12" cy="6.1" rx="7.5" ry="2.7" fill="#FF6B5B" fillOpacity="0.24" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      ) : (
        <>
          <path d="M 4.5 6.1 V 17.9 C 4.5 19.34 7.86 20.5 12 20.5 C 16.14 20.5 19.5 19.34 19.5 17.9 V 6.1" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 4.5 12 C 4.5 13.44 7.86 14.6 12 14.6 C 16.14 14.6 19.5 13.44 19.5 12" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <ellipse cx="12" cy="6.1" rx="7.5" ry="2.7" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'layers':
      return active ? (
        <>
          <path d="M 12 3.8 L 20 8.1 L 12 12.4 L 4 8.1 Z" fill="#FF6B5B" fillOpacity="0.22" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 4 12.3 L 12 16.6 L 20 12.3" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 4 16.4 L 12 20.7 L 20 16.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      ) : (
        <>
          <path d="M 12 3.8 L 20 8.1 L 12 12.4 L 4 8.1 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 4 12.3 L 12 16.6 L 20 12.3" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 4 16.4 L 12 20.7 L 20 16.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'sliders':
      return active ? (
        <>
          <path d="M 3.6 6 H 6.3 M 10.7 6 H 20.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="8.5" cy="6" r="2.2" stroke="currentColor" strokeWidth={sw}/>
          <path d="M 3.6 12 H 12.8 M 18.2 12 H 20.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="15.5" cy="12" r="2.7" fill="#FF6B5B"/>
          <path d="M 3.6 18 H 8.8 M 13.2 18 H 20.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="11" cy="18" r="2.2" stroke="currentColor" strokeWidth={sw}/>
        </>
      ) : (
        <>
          <path d="M 3.6 6 H 6.3 M 10.7 6 H 20.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="8.5" cy="6" r="2.2" stroke="currentColor" strokeWidth={sw}/>
          <path d="M 3.6 12 H 12.8 M 18.2 12 H 20.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="15.5" cy="12" r="2.2" stroke="currentColor" strokeWidth={sw}/>
          <path d="M 3.6 18 H 8.8 M 13.2 18 H 20.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="11" cy="18" r="2.2" stroke="currentColor" strokeWidth={sw}/>
        </>
      );

    case 'shield':
      return active ? (
        <>
          <path d="M 12 3.5 C 14.8 4.85 17.35 5.5 19.15 5.7 C 19.55 5.75 19.8 6.1 19.8 6.5 V 11.4 C 19.8 15.85 16.55 19.05 12.45 20.45 C 12.16 20.55 11.84 20.55 11.55 20.45 C 7.45 19.05 4.2 15.85 4.2 11.4 V 6.5 C 4.2 6.1 4.45 5.75 4.85 5.7 C 6.65 5.5 9.2 4.85 12 3.5 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 0 -3.8 C 0.53 -3.8 0.57 -1.55 1.06 -1.06 C 1.55 -0.57 3.8 -0.53 3.8 0 C 3.8 0.53 1.55 0.57 1.06 1.06 C 0.57 1.55 0.53 3.8 0 3.8 C -0.53 3.8 -0.57 1.55 -1.06 1.06 C -1.55 0.57 -3.8 0.53 -3.8 0 C -3.8 -0.53 -1.55 -0.57 -1.06 -1.06 C -0.57 -1.55 -0.53 -3.8 0 -3.8 Z" fill="#FF6B5B" transform="translate(12 11.7) rotate(14)"/>
        </>
      ) : (
        <>
          <path d="M 12 3.5 C 14.8 4.85 17.35 5.5 19.15 5.7 C 19.55 5.75 19.8 6.1 19.8 6.5 V 11.4 C 19.8 15.85 16.55 19.05 12.45 20.45 C 12.16 20.55 11.84 20.55 11.55 20.45 C 7.45 19.05 4.2 15.85 4.2 11.4 V 6.5 C 4.2 6.1 4.45 5.75 4.85 5.7 C 6.65 5.5 9.2 4.85 12 3.5 Z" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'bookOpen':
      return active ? (
        <>
          <path d="M 12 6.8 C 10.6 5.25 8.2 4.65 4.8 4.85 C 4.12 4.9 3.6 5.45 3.6 6.15 V 17.25 C 3.6 17.95 4.15 18.5 4.85 18.5 C 8.1 18.4 10.5 19.0 12 20.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 6.8 C 13.4 5.25 15.8 4.65 19.2 4.85 C 19.88 4.9 20.4 5.45 20.4 6.15 V 17.25 C 20.4 17.95 19.85 18.5 19.15 18.5 C 15.9 18.4 13.5 19.0 12 20.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 6.8 V 20.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 0 -3.2 C 0.45 -3.2 0.48 -1.32 0.9 -0.9 C 1.32 -0.48 3.2 -0.45 3.2 0 C 3.2 0.45 1.32 0.48 0.9 0.9 C 0.48 1.32 0.45 3.2 0 3.2 C -0.45 3.2 -0.48 1.32 -0.9 0.9 C -1.32 0.48 -3.2 0.45 -3.2 0 C -3.2 -0.45 -1.32 -0.48 -0.9 -0.9 C -0.48 -1.32 -0.45 -3.2 0 -3.2 Z" fill="#FF6B5B" transform="translate(16.2 11.6) rotate(14)"/>
        </>
      ) : (
        <>
          <path d="M 12 6.8 C 10.6 5.25 8.2 4.65 4.8 4.85 C 4.12 4.9 3.6 5.45 3.6 6.15 V 17.25 C 3.6 17.95 4.15 18.5 4.85 18.5 C 8.1 18.4 10.5 19.0 12 20.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 6.8 C 13.4 5.25 15.8 4.65 19.2 4.85 C 19.88 4.9 20.4 5.45 20.4 6.15 V 17.25 C 20.4 17.95 19.85 18.5 19.15 18.5 C 15.9 18.4 13.5 19.0 12 20.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 6.8 V 20.2" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'radio':
      return active ? (
        <>
          <path d="M 5.4 6.5 A 8.6 8.6 0 0 0 5.4 17.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 18.6 6.5 A 8.6 8.6 0 0 1 18.6 17.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 8.2 9.0 A 4.8 4.8 0 0 0 8.2 15.0" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 15.8 9.0 A 4.8 4.8 0 0 1 15.8 15.0" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="12" cy="12" r="2.35" fill="#FF6B5B"/>
        </>
      ) : (
        <>
          <path d="M 5.4 6.5 A 8.6 8.6 0 0 0 5.4 17.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 18.6 6.5 A 8.6 8.6 0 0 1 18.6 17.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 8.2 9.0 A 4.8 4.8 0 0 0 8.2 15.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 15.8 9.0 A 4.8 4.8 0 0 1 15.8 15.0" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="12" cy="12" r="1.65" fill="currentColor"/>
        </>
      );

    case 'code':
      return active ? (
        <>
          <path d="M 8.1 7.2 L 3.8 12 L 8.1 16.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 15.9 7.2 L 20.2 12 L 15.9 16.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 13.4 6.5 L 10.6 17.5" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      ) : (
        <>
          <path d="M 8.1 7.2 L 3.8 12 L 8.1 16.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 15.9 7.2 L 20.2 12 L 15.9 16.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'import':
      return active ? (
        <>
          <path d="M 4.2 13.8 V 17.5 C 4.2 18.88 5.32 20.0 6.7 20.0 H 17.3 C 18.68 20.0 19.8 18.88 19.8 17.5 V 13.8" fill="#FF6B5B" fillOpacity="0.16" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 4.0 V 14.3" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 8.0 10.6 L 12 14.6 L 16.0 10.6" stroke="#FF6B5B" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      ) : (
        <>
          <path d="M 4.2 13.8 V 17.5 C 4.2 18.88 5.32 20.0 6.7 20.0 H 17.3 C 18.68 20.0 19.8 18.88 19.8 17.5 V 13.8" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 12 4.0 V 14.3" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 8.0 10.6 L 12 14.6 L 16.0 10.6" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'cpu':
      return active ? (
        <>
          <rect x="6.5" y="6.5" width="11.0" height="11.0" rx="2.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 9.6 3.5 V 6.5 M 14.4 3.5 V 6.5 M 9.6 17.5 V 20.5 M 14.4 17.5 V 20.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round"/>
          <path d="M 3.5 9.6 H 6.5 M 3.5 14.4 H 6.5 M 17.5 9.6 H 20.5 M 17.5 14.4 H 20.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round"/>
          <rect x="9.3" y="9.3" width="5.4" height="5.4" rx="1.35" fill="#FF6B5B"/>
        </>
      ) : (
        <>
          <rect x="6.5" y="6.5" width="11.0" height="11.0" rx="2.4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 9.6 3.5 V 6.5 M 14.4 3.5 V 6.5 M 9.6 17.5 V 20.5 M 14.4 17.5 V 20.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round"/>
          <path d="M 3.5 9.6 H 6.5 M 3.5 14.4 H 6.5 M 17.5 9.6 H 20.5 M 17.5 14.4 H 20.5" stroke="currentColor" strokeWidth={sw} strokeLinecap="round"/>
          <rect x="9.6" y="9.6" width="4.8" height="4.8" rx="1.1" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'copy':
      return (
        <>
          <rect x="8.5" y="8.5" width="11" height="11" rx="2.2" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 15.5 8.5 V 6.7 C 15.5 5.48 14.52 4.5 13.3 4.5 H 6.7 C 5.48 4.5 4.5 5.48 4.5 6.7 V 13.3 C 4.5 14.52 5.48 15.5 6.7 15.5 H 8.5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'undo':
      return (
        <>
          <path d="M 8.5 7.3 L 4.8 11 L 8.5 14.7" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 5.2 11 H 14.3 C 17.0 11 19.2 12.95 19.2 15.35 C 19.2 17.4 17.6 19.0 15.4 19.0 H 11.8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'search':
      return (
        <>
          <circle cx="10.8" cy="10.8" r="6.2" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 15.4 15.4 L 19.6 19.6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'close':
      return (
        <>
          <path d="M 6.5 6.5 L 17.5 17.5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 17.5 6.5 L 6.5 17.5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'plus':
      return (
        <>
          <path d="M 12 5.2 V 18.8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
          <path d="M 5.2 12 H 18.8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
        </>
      );

    case 'check':
      return (
        <>
          <path d="M 5.0 12.6 L 9.6 17.2 L 19.0 7.4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'more':
      return (
        <>
          <circle cx="5.8" cy="12" r="1.35" fill="currentColor"/>
          <circle cx="12" cy="12" r="1.35" fill="currentColor"/>
          <circle cx="18.2" cy="12" r="1.35" fill="currentColor"/>
        </>
      );

    case 'chevronDown':
      return (
        <>
          <path d="M 6.5 9.4 L 12 15.0 L 17.5 9.4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'arrowRight':
      return (
        <>
          <path d="M 5.4 12 H 18.4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 13.4 7.0 L 18.6 12 L 13.4 17.0" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'trash':
      return (
        <>
          <path d="M 4.8 7.0 H 19.2" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 9.2 7.0 V 5.4 C 9.2 4.74 9.74 4.2 10.4 4.2 H 13.6 C 14.26 4.2 14.8 4.74 14.8 5.4 V 7.0" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 6.6 7.0 L 7.4 18.0 C 7.5 19.12 8.43 20.0 9.55 20.0 H 14.45 C 15.57 20.0 16.5 19.12 16.6 18.0 L 17.4 7.0" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 10.2 10.8 V 16.2 M 13.8 10.8 V 16.2" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
        </>
      );

    case 'pencil':
      return (
        <>
          <path d="M 15.6 4.6 L 19.4 8.4 L 9.2 18.6 L 4.6 19.4 L 5.4 14.8 L 15.6 4.6 Z" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 13.4 6.8 L 17.2 10.6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
        </>
      );

    case 'list':
      return (
        <>
          <circle cx="4.8" cy="6.8" r="1.05" fill="currentColor"/>
          <circle cx="4.8" cy="12.0" r="1.05" fill="currentColor"/>
          <circle cx="4.8" cy="17.2" r="1.05" fill="currentColor"/>
          <path d="M 8.6 6.8 H 19.4 M 8.6 12.0 H 19.4 M 8.6 17.2 H 19.4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
        </>
      );
      default:
        return null;
    }
  };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
      style={mergedStyle}
      aria-hidden={rest['aria-label'] ? undefined : true}
      {...rest}
    >
      {renderGlyph()}
    </svg>
  );
};

export default UtopinnIcon;
