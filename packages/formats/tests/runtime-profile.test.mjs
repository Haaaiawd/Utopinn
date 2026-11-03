// analyzeCardRuntime — synthetic cards + real private corpus (when present).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCardRuntime, readCardFromPng, cardData } from '../dist/index.js';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'corpus-private', 'cards');

// ── synthetic cards ───────────────────────────────────────────────────────

const v2 = (data) => ({ spec: 'chara_card_v2', spec_version: '2.0', data });

test('plain card → face:none, no mounts', () => {
    const p = analyzeCardRuntime(v2({ first_mes: 'Hello!', extensions: {} }));
    assert.equal(p.face, 'none');
    assert.equal(p.mounts.length, 0);
    assert.equal(p.takeover, false);
});

test('card_app declaration → ctx face + panel mount', () => {
    const p = analyzeCardRuntime(v2({
        first_mes: 'hi',
        extensions: { card_app: { enabled: true, entry: 'index.html' } },
    }));
    assert.equal(p.face, 'ctx');
    assert.deepEqual(p.mounts[0], { kind: 'panel', face: 'ctx', entry: 'index.html' });
});

test('tavern_helper scripts → th face + headless mounts + remote URLs', () => {
    const p = analyzeCardRuntime(v2({
        first_mes: 'hi',
        extensions: {
            tavern_helper: {
                scripts: [
                    { enabled: true, name: 'mvu', content: "import 'https://cdn.jsdelivr.net/gh/a/b@1.0/x.js'" },
                    { enabled: false, name: 'off', content: 'x' },
                ],
            },
        },
    }));
    assert.equal(p.face, 'th');
    assert.equal(p.thScriptCount, 1);
    assert.equal(p.mounts.filter(m => m.kind === 'headless').length, 1);
    assert.deepEqual(p.remoteResources, ['https://cdn.jsdelivr.net/gh/a/b@1.0/x.js']);
});

test('first_mes full HTML doc + body takeover → panel shell', () => {
    const p = analyzeCardRuntime(v2({
        first_mes: "<html><body><script>$('body').load('https://cdn.jsdelivr.net/x.html')</script></body></html>",
        extensions: {},
    }));
    assert.equal(p.face, 'th');
    assert.equal(p.takeover, true);
    assert.ok(p.mounts.some(m => m.kind === 'panel'));
});

test('first_mes HTML doc without takeover script → floor mount', () => {
    const p = analyzeCardRuntime(v2({
        first_mes: 'intro <pre>&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body&gt;status&lt;/body&gt;</pre>',
        alternate_greetings: ['plain alt'],
        extensions: {},
    }));
    // note: escaped entities don't match the raw predicate — unescaped form does
    const p2 = analyzeCardRuntime(v2({
        first_mes: 'x <html><head></head><body>status</body></html>',
        extensions: {},
    }));
    assert.equal(p2.face, 'th');
    assert.ok(p2.mounts.some(m => m.kind === 'floor'));
    assert.equal(p2.takeover, false);
    void p;
});

test('regex producing HTML fragment → inline mount (light frontend)', () => {
    const p = analyzeCardRuntime(v2({
        first_mes: 'hi',
        extensions: {
            regex_scripts: [
                { scriptName: 'status', replaceString: '<div class="bar">$1</div>', findRegex: 'x', placement: [2] },
                { scriptName: 'disabled', disabled: true, replaceString: '<div>x</div>' },
            ],
        },
    }));
    assert.equal(p.htmlRegexCount, 1);
    assert.ok(p.mounts.some(m => m.kind === 'inline'));
});

// ── real corpus ───────────────────────────────────────────────────────────

test('private corpus profiles', (t) => {
    if (!existsSync(CORPUS)) return t.skip('no private corpus');
    const results = {};
    for (const f of readdirSync(CORPUS)) {
        let raw;
        try { raw = readCardFromPng(readFileSync(join(CORPUS, f))); } catch { continue; }
        if (!raw) continue;
        const card = cardData(JSON.parse(raw));
        results[f] = analyzeCardRuntime(card);
    }
    const w = results['Wilderness_Survival_auto_1101_v2.png'];
    assert.ok(w, 'wilderness missing');
    assert.equal(w.face, 'th');
    assert.ok(w.thScriptCount >= 10, `expected ≥10 enabled TH scripts, got ${w.thScriptCount}`);
    assert.equal(w.mounts.filter(m => m.kind === 'headless').length, w.thScriptCount);
    const boss = Object.entries(results).find(([k]) => k.includes('废材教主'));
    assert.ok(boss, 'boss card missing');
    assert.equal(boss[1].takeover, true);
    const xx = Object.entries(results).find(([k]) => k.includes('诡异修仙'));
    assert.equal(xx[1].htmlRegexCount >= 1, true);
    const hs = Object.entries(results).find(([k]) => k.includes('高中生活模拟'));
    assert.equal(hs[1].face, 'none');
    for (const [f, p] of Object.entries(results)) {
        console.log(`  [profile] ${f.slice(0, 34)}: face=${p.face} takeover=${p.takeover} mounts=${p.mounts.length} th=${p.thScriptCount} htmlRx=${p.htmlRegexCount} remote=${p.remoteResources.length}`);
    }
});
