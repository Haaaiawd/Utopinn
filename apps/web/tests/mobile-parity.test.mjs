/**
 * Mobile/desktop feature-parity contract test.
 *
 * Scans every .ts/.tsx under src/ for form-factor decision points — any
 * `isMobile` read that picks a branch (&&, ||, ternary, if, negation).
 * Each flagged line must be claimed by an entry in lib/mobileParity.ts;
 * each entry's site substrings must exist in source. So:
 *   - new silent asymmetry        → unclaimed decision line → FAIL
 *   - removed/refactored fork     → stale manifest entry    → FAIL
 *   - prop threading / type decls → not decision points, ignored
 *
 * Structural assertions on top:
 *   - the CSS twin exists (@custom-variant mob, desk-only/mob-only,
 *     App writes html[data-vp])
 *   - SettingsModal and MobileSettingsSheet both render the shared
 *     SettingsTabContent (settings tabs cannot drift apart)
 *   - every ViewId in MOBILE_VIEW_MAP is actually remapped by gotoView
 *   - gated views keep an honest state (mob.view.noMobile)
 *
 * Run: node --test apps/web/tests/mobile-parity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOBILE_PARITY, MOBILE_VIEW_MAP } from '../src/lib/mobileParity.ts';

const SRC = join(fileURLToPath(import.meta.url), '../../src');
const MANIFEST = 'lib/mobileParity.ts';
const FLAG = 'isMobile';

/* Blank comments and string/template/regex contents (keeps line
   numbers): `//` inside a string must not start a comment, a `'` inside
   a regex must not open a string — a real state machine, not a regex.
   Regex-vs-division is decided from the last significant char (a `/`
   after a value/`)`/`]` is division). Flag reads inside template
   literals are invisible to the scanner; none exist today and sites
   must not span strings. */
function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let state = 'code'; // code | line | block | sq | dq | tpl | re | reclass
    let last = '';      // last significant char emitted in code state
    let depth = 0;      // { nesting — tracks which } closes a ${ … }
    const tpl = [];     // stack of brace depths at each ${ (nested templates)
    while (i < n) {
        const c = src[i];
        const d = src[i + 1];
        if (state === 'code') {
            if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
            /* `<`/`>` stay OUT of the opener set: `</div>`/`=>` would
               otherwise read as regex/string starts. A regex after an
               operator (`x < /re/`) is misread as division — harmless:
               its contents scan as code, and strings still blank. */
            const openPos = last === '' || '=([{,:;!&|?+-*%~^'.includes(last);
            if (c === '/' && openPos) {
                state = 're'; out += ' '; i += 1; last = '/'; continue;
            }
            /* Quotes open a string only in code position — JSX text like
               `don't` must not flip state. (Keyword-followed strings,
               e.g. `return 'x'`, stay visible as code: harmless — a
               false flag needs the flag token inside a string.) */
            if ((c === "'" || c === '"') && openPos) {
                state = c === "'" ? 'sq' : 'dq'; out += ' '; i += 1; continue;
            }
            if (c === '`') { state = 'tpl'; out += ' '; i += 1; continue; }
            if (c === '{') depth += 1;
            if (c === '}' && tpl.length && depth === tpl[tpl.length - 1]) {
                /* closing } of a ${ } — back into the template body */
                tpl.pop(); state = 'tpl'; out += ' '; i += 1; continue;
            }
            if (c === '}' && depth > 0) depth -= 1;
            out += c;
            if (!/\s/.test(c)) last = c;
            i += 1; continue;
        }
        if (state === 'line') {
            if (c === '\n') { state = 'code'; out += c; } else out += ' ';
            i += 1; continue;
        }
        if (state === 'block') {
            if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; }
            out += c === '\n' ? '\n' : ' '; i += 1; continue;
        }
        if (state === 'tpl') {
            if (c === '\\') { out += '  '; i += 2; continue; }
            if (c === '`') { state = 'code'; out += ' '; i += 1; continue; }
            if (c === '$' && d === '{') {
                /* ${ } — the expression is code again until its } */
                tpl.push(depth); state = 'code'; out += '  '; i += 2; continue;
            }
            out += c === '\n' ? '\n' : ' '; i += 1; continue;
        }
        if (state === 're') {
            if (c === '\\') { out += '  '; i += 2; continue; }
            if (c === '[') { state = 'reclass'; out += ' '; i += 1; continue; }
            if (c === '/') { state = 'code'; out += ' '; i += 1; continue; }
            out += c === '\n' ? '\n' : ' '; i += 1; continue;
        }
        if (state === 'reclass') {
            if (c === '\\') { out += '  '; i += 2; continue; }
            if (c === ']') { state = 're'; out += ' '; i += 1; continue; }
            out += c === '\n' ? '\n' : ' '; i += 1; continue;
        }
        const q = state === 'sq' ? "'" : '"';
        if (c === '\\') { out += '  '; i += 2; continue; }
        if (c === q) { state = 'code'; out += ' '; i += 1; continue; }
        out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    return out;
}

/* A decision point = the flag read next to a branch operator.
   Deliberately NOT matched: prop threading (`isMobile={isMobile}`,
   `<X isMobile />`), declarations (`const isMobile =`, `isMobile = false`),
   type positions (`isMobile?: boolean` — the `?` must not precede `:`),
   dep-array and object-literal mentions (`isMobile,` / `[s.isMobile]`). */
const DECISION = new RegExp(
    [
        String.raw`!\s*\w*\.?isMobile\b`,          // !isMobile / !s.isMobile
        String.raw`\bisMobile\s*\?(?!:)`,          // isMobile ? …
        String.raw`\bisMobile\s*(?:&&|\|\|)`,      // isMobile && / isMobile ||
        String.raw`(?:&&|\|\||\?)\s*\w*\.?isMobile\b`, // && s.isMobile / ? isMobile
        String.raw`\bif\s*\([^)]*\bisMobile\b`,    // if (…isMobile…)
    ].join('|'),
);

function listSourceFiles(dir, prefix = '') {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...listSourceFiles(join(dir, e.name), rel));
        else if (/\.(ts|tsx)$/.test(e.name) && rel !== MANIFEST) out.push(rel);
    }
    return out;
}

function flaggedLines(rel) {
    const raw = readFileSync(join(SRC, rel), 'utf8');
    const stripped = stripComments(raw).split('\n');
    const rawLines = raw.split('\n');
    const hits = [];
    stripped.forEach((line, idx) => {
        // flag on stripped code; site substrings match the RAW line so
        // they may include string literals ('half', 'closed', …)
        if (line.includes(FLAG) && DECISION.test(line)) hits.push({ line: idx + 1, text: rawLines[idx] });
    });
    return hits;
}

const files = listSourceFiles(SRC);
const flagged = new Map(files.map((f) => [f, flaggedLines(f)]));

test('every isMobile decision point is declared in the parity manifest', () => {
    const failures = [];
    for (const [file, hits] of flagged) {
        const entries = MOBILE_PARITY.filter((e) => e.file === file);
        for (const h of hits) {
            const claimed = entries.some((e) => e.sites.some((s) => h.text.includes(s)));
            if (!claimed) {
                failures.push(`${file}:${h.line} — undeclared form-factor fork: ${h.text.trim().slice(0, 120)}\n  → declare it in src/lib/mobileParity.ts or move it to CSS (mob:/desk-only/mob-only)`);
            }
        }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
});

test('every manifest entry still exists in source (no stale declarations)', () => {
    const failures = [];
    for (const e of MOBILE_PARITY) {
        const hits = flagged.get(e.file);
        assert.ok(hits, `manifest entry ${e.id}: file ${e.file} not found`);
        for (const s of e.sites) {
            if (!hits.some((h) => h.text.includes(s))) {
                failures.push(`${e.id} (${e.file}): site "${s.slice(0, 80)}" not found — fork removed? drop the manifest entry`);
            }
        }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
});

test('manifest entries are unique and well-formed', () => {
    const ids = MOBILE_PARITY.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate manifest ids');
    for (const e of MOBILE_PARITY) {
        assert.ok(e.sites.length > 0, `${e.id}: no sites`);
        assert.ok(e.mobile.length > 0 && e.why.length > 0, `${e.id}: mobile/why must be written`);
    }
});

test('CSS twin exists and is wired to the same flag (html[data-vp])', () => {
    const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    const spec = readFileSync(join(SRC, 'styles/spec.css'), 'utf8');
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    assert.match(tokens, /@custom-variant\s+mob\b/, 'tokens.css: mob: variant missing — JS twin has no CSS counterpart');
    assert.ok(spec.includes('[data-vp="mobile"] .desk-only'), 'spec.css: desk-only rule missing');
    assert.ok(spec.includes('mob-only'), 'spec.css: mob-only rule missing');
    assert.ok(app.includes('dataset.vp'), 'App.tsx: html[data-vp] writer missing — CSS twin would never fire');
});

test('settings overlays share one content component on both form factors', () => {
    const src = readFileSync(join(SRC, 'components/shell/Overlays.tsx'), 'utf8');
    for (const name of ['SettingsSheet', 'MobileSettingsSheet']) {
        const at = src.indexOf(`function ${name}`);
        assert.ok(at >= 0, `Overlays.tsx: ${name} missing`);
        const next = src.indexOf('\nfunction ', at + 1);
        const body = src.slice(at, next === -1 ? src.length : next);
        assert.ok(body.includes('<SettingsTabContent'), `${name} no longer renders SettingsTabContent — settings tabs forked`);
    }
});

test('gotoView remaps every declared mobile ViewId', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    for (const v of Object.keys(MOBILE_VIEW_MAP)) {
        assert.ok(app.includes(`v === '${v}'`), `gotoView no longer maps '${v}' — mobile reachability changed, update MOBILE_VIEW_MAP`);
    }
});

test('gated views keep an honest unavailable state', () => {
    const admin = readFileSync(join(SRC, 'components/views/admin.tsx'), 'utf8');
    assert.ok(admin.includes('mob.view.noMobile'), 'AdminView lost its mobile noMobile state — silent absence regressed');
});

test('report: classified decision points (audit trail)', () => {
    let total = 0;
    const rows = [];
    for (const [file, hits] of flagged) {
        for (const h of hits) {
            total += 1;
            const e = MOBILE_PARITY.find((x) => x.file === file && x.sites.some((s) => h.text.includes(s)));
            rows.push(`${file}:${h.line} → ${e ? e.id : 'UNDECLARED'}`);
        }
    }
    assert.ok(total >= MOBILE_PARITY.length, `only ${total} decision points for ${MOBILE_PARITY.length} entries`);
    console.log(`\n  parity scan: ${total} decision points across ${files.length} files\n  ${rows.join('\n  ')}`);
});
