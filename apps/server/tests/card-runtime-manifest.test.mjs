/**
 * card_app manifest parse/validate (node:test, no jest).
 * 跑法:node --test tests/card-runtime-manifest.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseCardAppManifest,
    normalizeAllowlistEntry,
    isAdmittedByAllowlist,
    isSafeRelativePath,
    getRawCardApp,
} from '../src/card-runtime/manifest.js';

const wrap = (cardApp, extra = {}) => ({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: 'T', extensions: { card_app: cardApp }, ...extra },
});

test('no card_app declaration → not ok', () => {
    const r = parseCardAppManifest({ data: { extensions: {} } });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /no extensions\.card_app/);
});

test('v1 flat card shape is read via data fallback', () => {
    const card = { name: 'T', extensions: { card_app: { enabled: true, entry: 'app.html' } } };
    const raw = getRawCardApp(card);
    assert.equal(raw.entry, 'app.html');
});

test('minimal manifest: entry defaults, permissions normalized', () => {
    const r = parseCardAppManifest(wrap({ enabled: true }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.manifest.entry, 'index.js');
    assert.equal(r.manifest.entryKind, 'module');
    assert.equal(r.manifest.enabled, true);
    assert.deepEqual(r.manifest.permissions.stateNamespaces, []);
    // TASK-046:module 入口默认 ctx+th 双 face(ctx 承载 init(ctx)+ctx.*,
    // th 兼容 T0 表);document 入口保持 TH 默认。permissions.api 显式声明可收窄。
    assert.deepEqual(r.manifest.permissions.api, ['ctx', 'th']);
});

test('document entry kinds recognized', () => {
    for (const entry of ['panel.html', 'a/b/index.htm', 'app.HTML']) {
        const r = parseCardAppManifest(wrap({ entry }));
        assert.equal(r.ok, true, `${entry}: ${r.errors}`);
        assert.equal(r.manifest.entryKind, 'document', entry);
    }
    const r = parseCardAppManifest(wrap({ entry: 'main.mjs' }));
    assert.equal(r.manifest.entryKind, 'module');
});

test('bad entries rejected loudly', () => {
    for (const [entry, re] of [
        ['../evil.js', /unsafe path/],
        ['/abs/x.js', /unsafe path/],
        ['a\\..\\x.js', /unsafe path/],
        ['readme.txt', /\.html\/\.htm\/\.js\/\.mjs/],
        ['x.js?v=2', /unsafe path/],
        ['C:/win/x.js', /unsafe path/],
        [42, /non-empty string/],
    ]) {
        const r = parseCardAppManifest(wrap({ entry }));
        assert.equal(r.ok, false, entry);
        assert.ok(r.errors.some(e => re.test(e)), `${entry} → ${r.errors}`);
    }
});

test('network allowlist: exact + prefix normalize, merged from permissions + resources', () => {
    const r = parseCardAppManifest(wrap({
        entry: 'a.html',
        permissions: { network: { allowlist: ['https://cdn.jsdelivr.net/gh/u/r@1/x.js', 'https://files.author.dev/lib/*'] } },
        resources: { allowlist: ['https://esm.sh/run*'] },
    }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const rules = r.manifest.permissions.network.allowlist;
    assert.equal(rules.length, 3);
    assert.deepEqual(rules[0], { kind: 'exact', value: 'https://cdn.jsdelivr.net/gh/u/r@1/x.js' });
    assert.deepEqual(rules[1], { kind: 'prefix', value: 'https://files.author.dev/lib/' });
    assert.deepEqual(rules[2], { kind: 'prefix', value: 'https://esm.sh/run' });

    assert.ok(isAdmittedByAllowlist('https://cdn.jsdelivr.net/gh/u/r@1/x.js', rules));
    assert.ok(!isAdmittedByAllowlist('https://cdn.jsdelivr.net/gh/u/r@1/other.js', rules));
    assert.ok(isAdmittedByAllowlist('https://files.author.dev/lib/deep/y.js', rules));
    assert.ok(isAdmittedByAllowlist('https://esm.sh/run/z', rules));
});

test('allowlist rejects bad URLs loudly', () => {
    for (const bad of [
        'not-a-url',
        'ftp://x/y.js',
        'https://user:pw@h/x',
        'https://h/*/mid.js',
        'javascript:alert(1)',
        '',
    ]) {
        const { entry, error } = normalizeAllowlistEntry(bad);
        assert.equal(entry, null, bad);
        assert.ok(error, bad);
    }
});

test('permissions validation: namespaces, api, bools', () => {
    const r = parseCardAppManifest(wrap({
        entry: 'a.html',
        permissions: {
            stateNamespaces: ['inventory', 'quest.log'],
            api: ['ctx', 'th.getVariables'],
            inlineScript: false,
            media: true,
            stateNamespacesBad: undefined,
        },
    }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.manifest.permissions.stateNamespaces, ['inventory', 'quest.log']);
    assert.deepEqual(r.manifest.permissions.api, ['ctx', 'th.getVariables']);
    assert.equal(r.manifest.permissions.inlineScript, false);
    assert.equal(r.manifest.permissions.media, true);

    for (const [perm, re] of [
        [{ stateNamespaces: ['a b!'] }, /invalid namespace/],
        [{ stateNamespaces: 'chat' }, /must be an array/],
        [{ api: ['fetch'] }, /invalid surface/],
        [{ api: 'ctx' }, /must be an array/],
        [{ inlineScript: 'yes' }, /must be a boolean/],
        [{ network: 'x' }, /must be an object/],
    ]) {
        const rr = parseCardAppManifest(wrap({ entry: 'a.html', permissions: perm }));
        assert.equal(rr.ok, false);
        assert.ok(rr.errors.some(e => re.test(e)), `${JSON.stringify(perm)} → ${rr.errors}`);
    }
});

test('sameOrigin warns (isolation weakening is explicit)', () => {
    const r = parseCardAppManifest(wrap({ entry: 'a.html', permissions: { sameOrigin: true } }));
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => /sameOrigin/.test(w)));
});

test('files map: unsafe keys degrade to warnings not errors', () => {
    const r = parseCardAppManifest(wrap({
        entry: 'i.js',
        files: { 'i.js': 'x', '../evil.js': 'x', 'ok/a.png': 'data:image/png;base64,AA==', 'bin': 42 },
    }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(r.warnings.some(w => /evil\.js/.test(w)));
    assert.ok(r.warnings.some(w => /bin/.test(w)));
});

test('isSafeRelativePath', () => {
    assert.ok(isSafeRelativePath('a/b/c.js'));
    assert.ok(!isSafeRelativePath(''));
    assert.ok(!isSafeRelativePath('/a'));
    assert.ok(!isSafeRelativePath('a//b'));
    assert.ok(!isSafeRelativePath('a/../b'));
    assert.ok(!isSafeRelativePath('a?x'));
    assert.ok(!isSafeRelativePath(123));
});

test('disabled card parses but reports enabled=false', () => {
    const r = parseCardAppManifest(wrap({ enabled: false, entry: 'x.js' }));
    assert.equal(r.ok, true);
    assert.equal(r.manifest.enabled, false);
});
