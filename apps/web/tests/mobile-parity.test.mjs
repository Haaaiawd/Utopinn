/**
 * Mobile/desktop feature-parity contract test.
 *
 * Scans every .ts/.tsx under src/ for form-factor decision points — any
 * `isMobile` read that picks a branch (&&, ||, ternary, if, negation).
 * Each flagged read must be covered by an entry in lib/mobileParity.ts
 * (a site substring that spans the flag token on its line); each entry's
 * sites must pin a live read in source. So:
 *   - new silent asymmetry        → uncovered decision read → FAIL
 *   - removed/refactored fork     → stale manifest entry    → FAIL
 *   - prop threading / type decls → not decision points, ignored
 *
 * Structural assertions on top:
 *   - the CSS twin exists (@custom-variant mob, desk-only/mob-only,
 *     App writes html[data-vp])
 *   - SettingsModal and MobileSettingsSheet both render the shared
 *     SettingsTabContent (settings tabs cannot drift apart)
 *   - every ViewId in MOBILE_VIEW_MAP lands on its declared target
 *     inside gotoView's mobile gate
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
   numbers and length): `//` inside a string must not start a comment,
   a `'` inside a regex must not open a string — a real state machine,
   not a regex. Regex-vs-division is decided from the last significant
   char (a `/` after a value/`)`/`]` is division). Flag reads inside
   template literals are invisible to the scanner; none exist today and
   sites must not span strings.
   With keepStrings=true only comments are blanked; string/template/
   regex contents stay verbatim — for assertions that must see literal
   text (t('key') call args, `v = 'target'` rewrites) yet must not be
   satisfied by commented-out code. */
function stripComments(src, keepStrings = false) {
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
                state = 're'; out += keepStrings ? c : ' '; i += 1; last = '/'; continue;
            }
            /* Quotes open a string only in code position — JSX text like
               `don't` must not flip state. (Keyword-followed strings,
               e.g. `return 'x'`, stay visible as code: harmless — a
               false flag needs the flag token inside a string.) */
            if ((c === "'" || c === '"') && openPos) {
                state = c === "'" ? 'sq' : 'dq'; out += keepStrings ? c : ' '; i += 1; continue;
            }
            if (c === '`') { state = 'tpl'; out += keepStrings ? c : ' '; i += 1; continue; }
            if (c === '{') depth += 1;
            if (c === '}' && tpl.length && depth === tpl[tpl.length - 1]) {
                /* closing } of a ${ } — back into the template body */
                tpl.pop(); state = 'tpl'; out += keepStrings ? c : ' '; i += 1; continue;
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
            if (c === '\\') { out += keepStrings ? src.slice(i, i + 2) : '  '; i += 2; continue; }
            if (c === '`') { state = 'code'; out += keepStrings ? c : ' '; i += 1; continue; }
            if (c === '$' && d === '{') {
                /* ${ } — the expression is code again until its } */
                tpl.push(depth); state = 'code'; out += keepStrings ? '${' : '  '; i += 2; continue;
            }
            out += c === '\n' ? '\n' : (keepStrings ? c : ' '); i += 1; continue;
        }
        if (state === 're') {
            if (c === '\\') { out += keepStrings ? src.slice(i, i + 2) : '  '; i += 2; continue; }
            if (c === '[') { state = 'reclass'; out += keepStrings ? c : ' '; i += 1; continue; }
            if (c === '/') { state = 'code'; out += keepStrings ? c : ' '; i += 1; continue; }
            out += c === '\n' ? '\n' : (keepStrings ? c : ' '); i += 1; continue;
        }
        if (state === 'reclass') {
            if (c === '\\') { out += keepStrings ? src.slice(i, i + 2) : '  '; i += 2; continue; }
            if (c === ']') { state = 're'; out += keepStrings ? c : ' '; i += 1; continue; }
            out += c === '\n' ? '\n' : (keepStrings ? c : ' '); i += 1; continue;
        }
        const q = state === 'sq' ? "'" : '"';
        if (c === '\\') { out += keepStrings ? src.slice(i, i + 2) : '  '; i += 2; continue; }
        if (c === q) { state = 'code'; out += keepStrings ? c : ' '; i += 1; continue; }
        out += c === '\n' ? '\n' : (keepStrings ? c : ' '); i += 1; continue;
    }
    return out;
}

/* A decision point = the flag read next to a branch operator.
   Deliberately NOT matched: prop threading (`isMobile={isMobile}`,
   `<X isMobile />`), declarations (`const isMobile =`, `isMobile = false`),
   type positions (`isMobile?: boolean` — the `?` must not precede `:`),
   dep-array and object-literal mentions (`isMobile,` / `[s.isMobile]`).
   `if` is absent on purpose: its condition may span lines and nest
   parens (`if (fn() && s.isMobile)`), so it is scanned structurally
   below instead of by regex. \s* still bridges newlines here, so
   operators separated from the flag by a line break are caught too. */
const DECISION = new RegExp(
    [
        String.raw`!\s*\w*\.?isMobile\b`,          // !isMobile / !s.isMobile
        String.raw`\bisMobile\s*\?(?!:)`,          // isMobile ? …
        String.raw`\bisMobile\s*(?:&&|\|\|)`,      // isMobile && / isMobile ||
        String.raw`(?:&&|\|\||\?)\s*\w*\.?isMobile\b`, // && s.isMobile / ? isMobile
    ].join('|'),
    'g',
);
const FLAG_IN_COND = new RegExp(`\\b${FLAG}\\b`, 'g');
const BRANCH_HEAD = /\b(?:if|while|for|switch)\s*\(/g;

function listSourceFiles(dir, prefix = '') {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...listSourceFiles(join(dir, e.name), rel));
        else if (/\.(ts|tsx)$/.test(e.name) && rel !== MANIFEST) out.push(rel);
    }
    return out;
}

/* Every isMobile offset that sits in a decision position, on stripped
   code (strings/comments already blanked — they cannot produce hits). */
function decisionOffsets(code) {
    const positions = new Set();
    /* Branch heads (if / else if / while / for / switch): find the
       balanced (...) so conditions spanning lines or containing calls
       — `if (\n  foo\n  && s.isMobile\n)`, `if (fn() && s.isMobile)` —
       cannot slip past. A bare `if (s.isMobile)` carries no branch
       operator, which is exactly what the regex list cannot see. */
    for (const m of code.matchAll(BRANCH_HEAD)) {
        const open = m.index + m[0].length - 1; // index of '('
        let depth = 1, j = open + 1;
        while (j < code.length && depth > 0) {
            if (code[j] === '(') depth += 1;
            else if (code[j] === ')') depth -= 1;
            j += 1;
        }
        for (const f of code.slice(open + 1, j - 1).matchAll(FLAG_IN_COND)) {
            positions.add(open + 1 + f.index);
        }
    }
    /* Operator-adjacent reads — run on the whole file (not per line):
       \s* eats newlines, so `isMobile\n? a : b` and `x &&\n s.isMobile`
       are flagged like their single-line forms. */
    for (const m of code.matchAll(DECISION)) {
        /* the flag token is always the LAST isMobile in the match —
           leading `\w*\.?` may swallow one (`&& xisMobile.isMobile`) */
        positions.add(m.index + m[0].lastIndexOf(FLAG));
    }
    return positions;
}

/* A hit = one isMobile token sitting in a decision position, keyed by
   its offset in the file (so two reads on one line count separately and
   the same read found twice counts once). text = the raw line holding
   that token; col = the flag's offset inside it — manifest sites match
   the raw line AND must cover col, so they may include string literals
   ('half', 'closed', …) and for multi-line conditions a site names a
   substring of the flag's own line. */
function flaggedLines(rel) {
    const raw = readFileSync(join(SRC, rel), 'utf8');
    const code = stripComments(raw);
    const rawLines = raw.split('\n');
    const nl = [-1];
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') nl.push(i);
    const lineAt = (p) => {
        let lo = 0, hi = nl.length;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (nl[m] < p) lo = m; else hi = m; }
        return lo + 1;
    };
    return [...decisionOffsets(code)].sort((a, b) => a - b)
        .map((p) => {
            const line = lineAt(p);
            return { line, col: p - nl[line - 1] - 1, text: rawLines[line - 1] };
        });
}

/* A manifest site pins a flag read only when an occurrence of the
   substring covers the hit's flag column. Two forks sharing a line
   (`if (isMobile) declared(); if (isMobile) undeclared();`) get
   separate hits, and a site naming the first fork cannot claim the
   second unless its own text spans that flag too. Sites that name only
   the bare condition (`if (s.isMobile)`) still claim identical same-line
   conditions — anchor precision is the manifest author's knob. */
function siteCovers(site, h) {
    let at = h.text.indexOf(site);
    while (at !== -1) {
        if (h.col >= at && h.col < at + site.length) return true;
        at = h.text.indexOf(site, at + 1);
    }
    return false;
}

const files = listSourceFiles(SRC);
const flagged = new Map(files.map((f) => [f, flaggedLines(f)]));

test('every isMobile decision point is declared in the parity manifest', () => {
    const failures = [];
    for (const [file, hits] of flagged) {
        const entries = MOBILE_PARITY.filter((e) => e.file === file);
        for (const h of hits) {
            const claimed = entries.some((e) => e.sites.some((s) => siteCovers(s, h)));
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
            if (!hits.some((h) => siteCovers(s, h))) {
                failures.push(`${e.id} (${e.file}): site "${s.slice(0, 80)}" pins no flag read — fork removed, or site doesn't span the flag token? fix or drop it`);
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

test('scanner: multi-line/same-line/nested forks caught; strings & comments cannot fake them', () => {
    const count = (src) => decisionOffsets(stripComments(src)).size;
    // multi-line if condition — flag on its own line
    assert.equal(count('if (\n    foo\n    && s.isMobile\n) { go(); }'), 1);
    // two ifs on one line — each flagged condition is its own decision
    assert.equal(count('if (a) { x(); } if (s.isMobile) { y(); }'), 1);
    assert.equal(count('if (a.isMobile) { x(); } if (b.isMobile) { y(); }'), 2);
    // nested parens inside the condition must not truncate the scan
    assert.equal(count('if (fn(a) && s.isMobile) { go(); }'), 1);
    // ternary/logical chains split across lines
    assert.equal(count('const x = s.isMobile\n    ? <A />\n    : <B />;'), 1);
    assert.equal(count('const y = ready &&\n    s.isMobile;'), 1);
    // string/template/regex/comment contents are invisible to the scan
    assert.equal(count("const a = 'if (s.isMobile) { }';"), 0);
    assert.equal(count('const t = `line\nif (s.isMobile) { }\nend`;'), 0);
    assert.equal(count('// if (s.isMobile) { }\n/* && s.isMobile */'), 0);
    // non-decision reads stay quiet: declarations, prop threading, types
    assert.equal(count("const isMobile = vp === 'mobile';"), 0);
    assert.equal(count('<X isMobile={isMobile} />'), 0);
    assert.equal(count('function f({ isMobile = false }: { isMobile?: boolean }) {}'), 0);
});

test('CSS twin exists and is wired to the same flag (html[data-vp])', () => {
    /* strip comments first — commented-out wiring must not satisfy this */
    const tokens = stripComments(readFileSync(join(SRC, 'styles/tokens.css'), 'utf8'), true);
    const spec = stripComments(readFileSync(join(SRC, 'styles/spec.css'), 'utf8'), true);
    const app = stripComments(readFileSync(join(SRC, 'App.tsx'), 'utf8'));
    assert.match(tokens, /@custom-variant\s+mob\b/, 'tokens.css: mob: variant missing — JS twin has no CSS counterpart');
    assert.ok(spec.includes('[data-vp="mobile"] .desk-only'), 'spec.css: desk-only rule missing');
    assert.ok(spec.includes('mob-only'), 'spec.css: mob-only rule missing');
    assert.ok(app.includes('dataset.vp'), 'App.tsx: html[data-vp] writer missing — CSS twin would never fire');
});

test('settings overlays share one content component on both form factors', () => {
    const src = stripComments(readFileSync(join(SRC, 'components/shell/Overlays.tsx'), 'utf8'));
    for (const name of ['SettingsSheet', 'MobileSettingsSheet']) {
        const at = src.indexOf(`function ${name}`);
        assert.ok(at >= 0, `Overlays.tsx: ${name} missing`);
        const next = src.indexOf('\nfunction ', at + 1);
        const body = src.slice(at, next === -1 ? src.length : next);
        assert.ok(body.includes('<SettingsTabContent'), `${name} no longer renders SettingsTabContent — settings tabs forked`);
    }
});

test('gotoView remaps every declared mobile ViewId to its declared target', () => {
    const raw = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    const code = stripComments(raw);         // code only — strings/comments blanked
    const live = stripComments(raw, true);   // comments blanked, strings verbatim
    const gv = code.indexOf('gotoView');
    assert.ok(gv >= 0, 'App.tsx: gotoView missing — mobile domain map has no host');
    const mapIf = code.indexOf('isMobile && !deep', gv);
    assert.ok(mapIf >= 0, 'gotoView lost its isMobile domain-map gate');
    /* Bound the check to the gate's { … } block (brace match on `code`
       so braces inside literals cannot miscount), then read each guard
       out of code state: `v ===` in code + quoted key in `live` — a
       comment or string literal cannot fake either. */
    const brace = code.indexOf('{', mapIf);
    let depth = 1, end = brace + 1;
    while (end < code.length && depth > 0) {
        if (code[end] === '{') depth += 1;
        else if (code[end] === '}') depth -= 1;
        end += 1;
    }
    const codeB = code.slice(brace, end);
    const liveB = live.slice(brace, end);
    /* `v ===` in code state, quoted key right after it in `live`.
       Never let \s* run on `code` — it would eat blanked-string spaces
       and land the check past the literal. */
    const guardAt = new Map();
    for (const m of codeB.matchAll(/\bv ===/g)) {
        const arg = /^\s*'(\w+)'/.exec(liveB.slice(m.index + m[0].length));
        if (arg && !guardAt.has(arg[1])) guardAt.set(arg[1], m.index);
    }
    for (const [v, target] of Object.entries(MOBILE_VIEW_MAP)) {
        const gi = guardAt.get(v);
        assert.ok(gi !== undefined, `gotoView no longer maps '${v}' — mobile reachability changed, update MOBILE_VIEW_MAP`);
        /* Scope ends at the next guard so a rewrite meant for a different
           key cannot satisfy this one. Target convention: 'desc (call)'
           → call('v'); bare view id → v = 'target'. The operator token
           must sit in code state, the literal target right after it. */
        const later = [...guardAt.values()].filter((x) => x > gi);
        const end2 = later.length ? Math.min(...later) : codeB.length;
        const codeS = codeB.slice(gi, end2);
        const liveS = liveB.slice(gi, end2);
        const call = /\((\w+)\)/.exec(target);
        const kw = call ? new RegExp(`\\b${call[1]}\\(`, 'g') : /\bv\s*=(?!=)/g;
        const lit = (call ? `'${v}'` : `'${target}'`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const ok = [...codeS.matchAll(kw)].some((m) =>
            new RegExp(`^\\s*${lit}`).test(liveS.slice(m.index + m[0].length)));
        const want = call ? `${call[1]}('${v}')` : `v = '${target}'`;
        assert.ok(ok, `'${v}' guard no longer lands on ${want} — MOBILE_VIEW_MAP declares '${target}'`);
    }
});

test('gated views keep an honest unavailable state', () => {
    /* The t() call must be live code: `t(` found in code state, the
       quoted key right after it in `live` — a comment, a bare key
       mention, or a string literal faking the call cannot satisfy. */
    const raw = readFileSync(join(SRC, 'components/views/admin.tsx'), 'utf8');
    const code = stripComments(raw);
    const live = stripComments(raw, true);
    const ok = [...code.matchAll(/\bt\(/g)]
        .some((m) => /^\s*["']mob\.view\.noMobile["']/.test(live.slice(m.index + m[0].length)));
    assert.ok(ok, 'AdminView lost its mobile noMobile state — silent absence regressed');
});

test('report: classified decision points (audit trail)', () => {
    let total = 0;
    const rows = [];
    for (const [file, hits] of flagged) {
        for (const h of hits) {
            total += 1;
            const e = MOBILE_PARITY.find((x) => x.file === file && x.sites.some((s) => siteCovers(s, h)));
            rows.push(`${file}:${h.line} → ${e ? e.id : 'UNDECLARED'}`);
        }
    }
    assert.ok(total >= MOBILE_PARITY.length, `only ${total} decision points for ${MOBILE_PARITY.length} entries`);
    console.log(`\n  parity scan: ${total} decision points across ${files.length} files\n  ${rows.join('\n  ')}`);
});
