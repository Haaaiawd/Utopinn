// 24-grid stroke icon set (IA §14 UI rule: no emoji as icons; stroke SVG only,
// same family as dsh-tavern ICON_PATHS / feather). Emoji stays allowed inside
// user content (card text, messages).
import type { ReactNode } from 'react';

const PATHS = {
    /* L1 主 tab 标 — 复合剪影:每个都是「主体+细节」两三层,比通用线稿丰富 */
    chat: (
        <>
            <path d="M19 4.5H6A3.5 3.5 0 0 0 2.5 8v5.5A3.5 3.5 0 0 0 6 17h1.6l-1.4 3.4c-.4.9.5 1.8 1.4 1.3L12.6 19H19a3.5 3.5 0 0 0 3.5-3.5V8A3.5 3.5 0 0 0 19 4.5z" transform="translate(-.8 -.5)" />
            <path d="M7.2 9.2h9.6" />
            <path d="M7.2 12.6h5.8" />
            <circle cx="16.4" cy="12.6" r=".9" fill="currentColor" stroke="none" />
        </>
    ),
    stories: (
        <>
            <rect x="3" y="4.5" width="12.5" height="16.5" rx="2.5" />
            <path d="M18 7 20.6 7.8a1.2 1.2 0 0 1 .8 1.2v10.5a1.7 1.7 0 0 1-1.7 1.7H18" />
            <circle cx="8" cy="9.5" r="1.9" />
            <path d="M6 15.4c1.1-1.2 2.9-1.2 4 0" />
            <path d="M6.2 18.4h5.6" />
        </>
    ),
    rules: (
        <>
            <path d="M6.5 3.5h11A2.8 2.8 0 0 1 20.3 6.3V8" />
            <path d="M6.5 3.5A2.8 2.8 0 0 0 3.7 6.3v11.4a2.8 2.8 0 0 0 2.8 2.8h11a2.8 2.8 0 0 0 2.8-2.8V8" />
            <path d="M6.5 3.5a2.8 2.8 0 0 1 2.8 2.8V8" />
            <circle cx="12" cy="12.6" r="3.4" />
            <path d="M12 15.2a2.6 2.6 0 0 1-2.6-2.6" opacity=".55" />
            <path d="M18.8 8l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z" fill="currentColor" stroke="none" />
        </>
    ),
    extensions: (
        <>
            <path d="M9.5 6.8V5a2.4 2.4 0 0 1 4.8 0v1.8H17a2 2 0 0 1 2 2v2.6h1.8a2.4 2.4 0 0 1 0 4.8H19V19a2 2 0 0 1-2 2h-2.6v1.6a2.4 2.4 0 0 1-4.8 0V21H7a2 2 0 0 1-2-2v-2.6H3.4a2.4 2.4 0 0 1 0-4.8H5V9a2 2 0 0 1 2-2z" transform="translate(-.5 -1.2) scale(.92)" />
            <circle cx="12" cy="13" r="1.5" />
        </>
    ),
    diagnostics: (
        <>
            <path d="M2.5 13h4l2.3-6.3 4.2 12.6 2.2-6.3H20" />
            <circle cx="20.5" cy="13" r="1.7" />
            <path d="M3 5.5c1.5 0 1.5 0 3 0" opacity=".5" />
        </>
    ),
    settings: (
        <>
            <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
            <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
            <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" />
            <line x1="17" y1="16" x2="23" y2="16" />
        </>
    ),
    search: (
        <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>
    ),
    plus: (
        <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>
    ),
    send: (
        <><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></>
    ),
    refresh: (
        <>
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </>
    ),
    panelRight: (
        <><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" /></>
    ),
    sidebarLeft: (
        <><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></>
    ),
    chevronDown: <polyline points="6 9 12 15 18 9" />,
    chevronRight: <polyline points="9 18 15 12 9 6" />,
    chevronLeft: <polyline points="15 18 9 12 15 6" />,
    edit: (
        <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" /></>
    ),
    more: (
        <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>
    ),
    x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
    minus: <line x1="5" y1="12" x2="19" y2="12" />,
    square: <rect x="5" y="5" width="14" height="14" rx="1" />,
    moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
    sun: (
        <>
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </>
    ),
    eye: (
        <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>
    ),
    import: (
        <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>
    ),
    zap: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
    command: (
        <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
    ),
    clock: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
    user: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
    layers: (
        <><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></>
    ),
    file: (
        <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>
    ),
    list: (
        <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>
    ),
    layout: <><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" /></>,
    grid: (
        <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>
    ),
    check: <polyline points="20 6 9 17 4 12" />,
    book: (
        <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>
    ),
    focus: (
        <><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>
    ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 17, className }: { name: IconName; size?: number; className?: string }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            {PATHS[name]}
        </svg>
    );
}

/* L1 = 各主 tab 的轨标(上面 PATHS 前六个):复合剪影、多元素、有性格。
   L2 = 次级操作 icon,L3 = 行内小 icon,都是朴素线稿。 */
