/**
 * analyzeCardRuntime — mechanism-level capability detection for card frontends.
 *
 * Inspects the *declared and embedded* runtime surfaces of a character card and
 * produces a `CardRuntimeProfile` the host uses to decide which mounts to spin
 * up (panel shell / floor apps / headless scripts / inline HTML) and which
 * remote origins to pre-allow. Detection is card-agnostic: it reads the same
 * markers the ecosystem runtimes read (card_app declaration, tavern_helper
 * scripts, the isFrontend `<pre>`-full-HTML contract, body-takeover patterns).
 *
 * See .skeinn/capabilities/sandboxed-card-apps/research/card-runtime-ecosystem.md
 */

export type RuntimeMount =
    | { kind: 'panel'; face: 'ctx' | 'th'; entry?: string }
    | { kind: 'floor'; face: 'th'; messageId?: number }
    | { kind: 'headless'; face: 'th'; scriptId: string; name?: string }
    | { kind: 'inline'; reason: 'regex-html' | 'message-html' };

export interface CardRuntimeProfile {
    /** Which bridge face card code expects; 'none' = no card JS at all. */
    face: 'ctx' | 'th' | 'none';
    /** Mounts the host should create for this card. */
    mounts: RuntimeMount[];
    /** True when the card replaces the whole viewport (galgame-style shell). */
    takeover: boolean;
    /** Remote URLs found in card scripts / greetings — seed for the CDN-proxy allowlist. */
    remoteResources: string[];
    /** Distinct remote hosts with a known-CDN flag (known → default-allow policy candidate). */
    remoteHosts: { host: string; knownCdn: boolean }[];
    /** Enabled TavernHelper script count (0 when card doesn't declare TH). */
    thScriptCount: number;
    /** Regex scripts that rewrite AI output into HTML (light-frontend signal). */
    htmlRegexCount: number;
    /** Human-readable detection signals (debugging / card-info UI). */
    signals: string[];
}

// ─── detection helpers ───────────────────────────────────────────────────

/** TH's isFrontend contract: a `<pre>` block counts as frontend iff its text
 *  contains a full-document marker. We reuse the exact predicate. */
const HTML_DOC_RE = /html>|<head>|<body/i;
const SCRIPT_TAG_RE = /<script[\s>]/i;
const BODY_TAKEOVER_RE = /\$\s*\(\s*(['"])body\1\s*\)|document\.body|body\s*\)\s*\.load\s*\(|\.load\s*\(\s*['"]https?:/i;
const REMOTE_URL_RE = /https?:\/\/[^\s'"<>)\]]+/gi;
const IMPORT_STMT_RE = /import\s*[\w{*][^'"]*['"](https?:\/\/[^'"]+)['"]|import\s*\(\s*['"](https?:\/\/[^'"]+)['"]|import\s+['"](https?:\/\/[^'"]+)['"]/g;

const KNOWN_CDN_HOSTS = [
    'cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net',
    'testingcf.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
    'esm.sh', 'esm.run', 'raw.githubusercontent.com',
];

function collectRemoteUrls(text: string): string[] {
    const urls = new Set<string>();
    for (const m of text.matchAll(IMPORT_STMT_RE)) {
        const u = m[1] ?? m[2] ?? m[3];
        if (u) urls.add(u);
    }
    for (const m of text.matchAll(REMOTE_URL_RE)) {
        try {
            new URL(m[0]); // validity check only — every URL is an egress candidate
            urls.add(m[0]);
        } catch { /* ignore malformed */ }
    }
    return [...urls];
}

interface TavernHelperScript {
    type?: string;
    enabled?: boolean;
    name?: string;
    id?: string;
    content?: string;
    export_with?: boolean;
}

interface RegexScript {
    scriptName?: string;
    findRegex?: string;
    replaceString?: string;
    placement?: number[];
    disabled?: boolean;
    markdownOnly?: boolean;
    displayOnly?: boolean;
    promptOnly?: boolean;
}

function extensionsOf(card: Record<string, unknown>): Record<string, unknown> {
    const data = card.data as Record<string, unknown> | undefined;
    return ((data?.extensions ?? card.extensions) ?? {}) as Record<string, unknown>;
}

function greetingsOf(card: Record<string, unknown>): string[] {
    const data = card.data as Record<string, unknown> | undefined;
    const src = (data ?? card) as Record<string, unknown>;
    const out: string[] = [];
    if (typeof src.first_mes === 'string') out.push(src.first_mes);
    if (Array.isArray(src.alternate_greetings)) {
        for (const g of src.alternate_greetings) if (typeof g === 'string') out.push(g);
    }
    return out;
}

/**
 * Build the runtime profile for a parsed character card
 * (`card.data` envelope or the normalized `cardData()` view).
 */
export function analyzeCardRuntime(card: Record<string, unknown>): CardRuntimeProfile {
    const ext = extensionsOf(card);
    const mounts: RuntimeMount[] = [];
    const signals: string[] = [];
    const remoteResources = new Set<string>();
    let face: CardRuntimeProfile['face'] = 'none';
    let takeover = false;
    let htmlRegexCount = 0;

    // 1) Luker CardApp declaration → ctx face, panel mount
    const cardApp = ext.card_app as { enabled?: boolean; entry?: string } | undefined;
    if (cardApp && cardApp.enabled !== false) {
        face = 'ctx';
        mounts.push({ kind: 'panel', face: 'ctx', entry: cardApp.entry });
        signals.push('card_app declaration');
    }

    // 2) TavernHelper scripts → th face, headless mounts + remote URLs
    const th = ext.tavern_helper as { scripts?: TavernHelperScript[] } | undefined;
    const thScripts = (th?.scripts ?? []).filter(s => s.enabled !== false);
    if (thScripts.length > 0) {
        if (face === 'none') face = 'th';
        for (const s of thScripts) {
            mounts.push({ kind: 'headless', face: 'th', scriptId: s.id ?? s.name ?? 'unnamed', name: s.name });
            for (const u of collectRemoteUrls(String(s.content ?? ''))) remoteResources.add(u);
        }
        signals.push(`tavern_helper scripts ×${thScripts.length}`);
    } else if (th !== undefined) {
        if (face === 'none') face = 'th';
        signals.push('tavern_helper extension declared');
    }

    // 3) Greetings carrying full HTML documents → floor app(s); takeover when
    //    the doc scripts itself into the whole viewport (galgame-style shell).
    const greetings = greetingsOf(card);
    for (const [i, g] of greetings.entries()) {
        if (HTML_DOC_RE.test(g)) {
            const scripted = SCRIPT_TAG_RE.test(g);
            const takesOver = BODY_TAKEOVER_RE.test(g) || (scripted && i === 0 && greetings.length === 1);
            for (const u of collectRemoteUrls(g)) remoteResources.add(u);
            if (takesOver) {
                takeover = true;
                mounts.push({ kind: 'panel', face: face === 'ctx' ? 'ctx' : 'th', entry: 'first_mes' });
                signals.push(`takeover shell in ${i === 0 ? 'first_mes' : `greeting[${i}]`}`);
            } else {
                mounts.push({ kind: 'floor', face: 'th', messageId: i === 0 ? 0 : undefined });
                signals.push(`full HTML doc in ${i === 0 ? 'first_mes' : `greeting[${i}]`}`);
            }
        } else if (SCRIPT_TAG_RE.test(g)) {
            mounts.push({ kind: 'floor', face: 'th', messageId: i === 0 ? 0 : undefined });
            signals.push(`script tag in ${i === 0 ? 'first_mes' : `greeting[${i}]`}`);
        }
    }

    // 4) Regex scripts producing HTML output → light-frontend inline render.
    //    Full-doc replacements are floor apps, fragment replacements are inline.
    const regexes = (ext.regex_scripts ?? []) as RegexScript[];
    for (const r of regexes) {
        if (r.disabled) continue;
        const rep = String(r.replaceString ?? '');
        if (HTML_DOC_RE.test(rep)) {
            mounts.push({ kind: 'floor', face: 'th' });
            htmlRegexCount++;
            signals.push(`regex '${r.scriptName ?? '?'}' produces full HTML doc`);
        } else if (/<\w+[^>]*>/.test(rep) || SCRIPT_TAG_RE.test(rep)) {
            htmlRegexCount++;
            signals.push(`regex '${r.scriptName ?? '?'}' produces HTML fragment`);
        }
    }
    const hasInlineMount = mounts.some(m => m.kind === 'inline');
    if (htmlRegexCount > 0 && !hasInlineMount) {
        mounts.push({ kind: 'inline', reason: 'regex-html' });
    }

    if (face === 'none' && mounts.length > 0) face = 'th';
    const remoteHosts = [...new Set(
        [...remoteResources].map(u => { try { return new URL(u).hostname; } catch { return null; } })
            .filter((h): h is string => h !== null),
    )].map(host => ({ host, knownCdn: KNOWN_CDN_HOSTS.includes(host) }));
    return {
        face,
        mounts: dedupeMounts(mounts),
        takeover,
        remoteResources: [...remoteResources],
        remoteHosts,
        thScriptCount: thScripts.length,
        htmlRegexCount,
        signals,
    };
}

function dedupeMounts(mounts: RuntimeMount[]): RuntimeMount[] {
    const seen = new Set<string>();
    return mounts.filter(m => {
        const key = m.kind === 'headless' ? `headless:${m.scriptId}` : m.kind;
        if (m.kind === 'headless') {
            if (seen.has(key)) return false;
        } else if (seen.has(m.kind) && m.kind !== 'floor') {
            return false;
        }
        seen.add(key);
        return true;
    });
}
