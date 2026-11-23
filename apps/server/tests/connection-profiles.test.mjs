/**
 * connection profiles —— 档案制核心单测(node:test,纯函数面):
 *   resolveConnectionDispatch:profile 覆盖袋 + anti-bleed + 模型兜底序
 *   + 旧单槽兜底;readConnectionProfiles/readActiveModel 归一化;
 *   synthesizeLegacyProfile 迁移合成(含旧键不删、模型/端点/格式映射)。
 * 跑法:node --test tests/connection-profiles.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let CONNECTION_KEYS;
let PROFILE_FORMATS;
let readConnectionProfiles;
let readActiveModel;
let resolveActiveProfile;
let profileDispatchBag;
let resolveConnectionDispatch;
let presetToDispatchParams;
let synthesizeLegacyProfile;
let sanitizeProfileInput;

// secrets.js 链模块级读 config —— 先 setConfigFilePath 再动态 import。
test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    const mod = await import('../src/services/connection-dispatch.js');
    ({
        CONNECTION_KEYS,
        PROFILE_FORMATS,
        readConnectionProfiles,
        readActiveModel,
        resolveActiveProfile,
        profileDispatchBag,
        resolveConnectionDispatch,
        presetToDispatchParams,
        synthesizeLegacyProfile,
        sanitizeProfileInput,
    } = mod);
});

const PROF_DS = {
    id: 'p-ds', name: 'DeepSeek', format: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', secretId: 'sec-1',
    models: { checked: ['deepseek-chat', 'deepseek-reasoner'], manual: ['ds-manual'] },
};
const PROF_CL = {
    id: 'p-cl', name: 'Claude', format: 'anthropic',
    baseUrl: 'https://proxy.example.com', secretId: 'sec-2',
    models: { checked: [], manual: ['claude-opus-4'] },
};

function oaiWith(profiles, activeModel = null) {
    return {
        chat_completion_source: 'openai',
        openai_model: 'gpt-legacy',
        reverse_proxy: 'https://old-proxy.example.com',
        custom_url: 'https://old-custom.example.com',
        proxy_password: 'leak-me-not',
        temperature: 0.7,
        connection_profiles: profiles,
        connection: { activeModel },
    };
}

test('profile dispatch: openai 格式 → custom 源 + anti-bleed 空串', () => {
    const { body, profile } = resolveConnectionDispatch(
        oaiWith([PROF_DS], { profileId: 'p-ds', modelId: 'deepseek-chat' }),
        { temperature: 0.9, chat_completion_source: 'claude' }, // 预设源字段被剥
        {},
    );
    assert.equal(profile?.id, 'p-ds');
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.custom_url, 'https://api.deepseek.com/v1');
    assert.equal(body.reverse_proxy, '');
    assert.equal(body.base_url, '');
    assert.equal(body.proxy_password, '');
    assert.equal(body.secret_id, 'sec-1');
    assert.equal(body.profile_id, 'p-ds');
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.temperature, 0.9); // 预设参数照吃
});

test('profile dispatch: anthropic 格式 → claude 源 + url 走 reverse_proxy', () => {
    const { body, profile } = resolveConnectionDispatch(
        oaiWith([PROF_CL], { profileId: 'p-cl', modelId: 'claude-opus-4' }),
        {},
        {},
    );
    assert.equal(profile?.id, 'p-cl');
    assert.equal(body.chat_completion_source, 'claude');
    assert.equal(body.reverse_proxy, 'https://proxy.example.com');
    assert.equal(body.custom_url, '');
    assert.equal(body.base_url, '');
    assert.equal(body.secret_id, 'sec-2');
    assert.equal(body.model, 'claude-opus-4');
});

test('profile dispatch: anthropic 空 baseUrl → 官方端点(空串照传)', () => {
    const p = { ...PROF_CL, baseUrl: '' };
    const { body } = resolveConnectionDispatch(
        oaiWith([p], { profileId: 'p-cl', modelId: 'm' }), {}, {},
    );
    assert.equal(body.chat_completion_source, 'claude');
    assert.equal(body.reverse_proxy, '');
});

test('模型兜底序:body.model > activeModel.modelId > checked[0] > manual[0]', () => {
    const oai = oaiWith([PROF_DS], { profileId: 'p-ds', modelId: 'deepseek-reasoner' });
    // body.model 显式压一切
    assert.equal(resolveConnectionDispatch(oai, {}, { model: 'explicit' }).body.model, 'explicit');
    // activeModel.modelId
    assert.equal(resolveConnectionDispatch(oai, {}, {}).body.model, 'deepseek-reasoner');
    // checked[0]
    const oai2 = oaiWith([PROF_DS], { profileId: 'p-ds', modelId: '' });
    assert.equal(resolveConnectionDispatch(oai2, {}, { profile_id: 'p-ds' }).body.model, 'deepseek-chat');
    // manual[0](checked 空)
    const p3 = { ...PROF_DS, models: { checked: [], manual: ['ds-manual'] } };
    assert.equal(resolveConnectionDispatch(oaiWith([p3]), {}, { profile_id: 'p-ds' }).body.model, 'ds-manual');
});

test('profile 选择:body.profile_id > activeModel.profileId;disabled 不命中', () => {
    const oai = oaiWith([PROF_DS, PROF_CL], { profileId: 'p-cl', modelId: 'claude-opus-4' });
    // 显式指 p-ds 压过指针 p-cl
    assert.equal(resolveConnectionDispatch(oai, {}, { profile_id: 'p-ds' }).profile?.id, 'p-ds');
    // 指针生效
    assert.equal(resolveConnectionDispatch(oai, {}, {}).profile?.id, 'p-cl');
    // disabled 档不可选 → 掉回旧单槽
    const oai2 = oaiWith([{ ...PROF_DS, disabled: true }], { profileId: 'p-ds', modelId: 'x' });
    const r = resolveConnectionDispatch(oai2, {}, {});
    assert.equal(r.profile, null);
    assert.equal(r.body.chat_completion_source, 'openai'); // legacy 面
});

test('旧单槽兜底:无 profile / 无指针 → 与修前逐字同构', () => {
    const oai = {
        chat_completion_source: 'deepseek',
        deepseek_model: 'deepseek-v3',
        temperature: 0.5,
    };
    const { body, profile } = resolveConnectionDispatch(oai, { temperature: 0.9 }, {});
    assert.equal(profile, null);
    assert.equal(body.chat_completion_source, 'deepseek');
    assert.equal(body.model, 'deepseek-v3');
    assert.equal(body.temperature, 0.9);
    // 空 oai → source 'openai',model null
    const r2 = resolveConnectionDispatch({}, {}, {});
    assert.equal(r2.profile, null);
    assert.equal(r2.body.chat_completion_source, 'openai');
    assert.equal(r2.body.model, null);
});

test('presetToDispatchParams:connection_profiles/connection/profile_id 在剥除集内', () => {
    assert.ok(CONNECTION_KEYS.has('connection_profiles'));
    assert.ok(CONNECTION_KEYS.has('connection'));
    assert.ok(CONNECTION_KEYS.has('profile_id'));
    const out = presetToDispatchParams({
        temperature: 1, connection_profiles: [{ id: 'x' }],
        connection: { activeModel: { profileId: 'x', modelId: 'y' } },
        profile_id: 'x', model: 'wire-model',
    });
    assert.deepEqual(out, { temperature: 1 }); // model 是 wire 键本就不透传
});

test('readConnectionProfiles 归一化:脏条丢弃/models 三槽归位/lastProbe 保留', () => {
    const out = readConnectionProfiles({
        connection_profiles: [
            null, 'x', { name: 'no id' },
            {
                id: ' a ', name: '', format: 'weird', baseUrl: ' u ',
                secretId: ' ', models: { checked: ['m1', ' m1 ', '  '], manual: 'no', lastProbe: { at: '5', ok: 1, items: [{ id: 'x' }, 'y', {}] } },
                disabled: 1,
            },
        ],
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
        id: 'a', name: 'a', format: 'openai', baseUrl: 'u', secretId: null,
        models: { checked: ['m1'], manual: [], lastProbe: { at: 5, ok: true, items: [{ id: 'x' }, { id: 'y' }] } },
        disabled: true,
    });
});

test('readActiveModel / resolveActiveProfile 边界', () => {
    assert.equal(readActiveModel({}), null);
    assert.equal(readActiveModel({ connection: { activeModel: { profileId: 'p' } } }), null);
    assert.deepEqual(
        readActiveModel({ connection: { activeModel: { profileId: 'p', modelId: 'm' } } }),
        { profileId: 'p', modelId: 'm' },
    );
    assert.equal(resolveActiveProfile(oaiWith([], null), {}), null);
    assert.equal(resolveActiveProfile(oaiWith([PROF_DS], { profileId: 'ghost', modelId: 'm' }), {}), null);
});

test('profileDispatchBag:格式映射 + 袋内 profile_id/model', () => {
    const o = profileDispatchBag(PROF_DS, 'm1');
    assert.equal(o.chat_completion_source, 'custom');
    assert.equal(o.profile_id, 'p-ds');
    assert.equal(o.model, 'm1');
    const c = profileDispatchBag(PROF_CL, null);
    assert.equal(c.chat_completion_source, 'claude');
    assert.equal(c.custom_url, '');
    assert.equal(c.model, null);
    assert.ok(PROFILE_FORMATS.includes('openai') && PROFILE_FORMATS.includes('anthropic'));
});

test('synthesizeLegacyProfile:openai 生态源 → openai 格式 + 官方端点物化', () => {
    const p = synthesizeLegacyProfile({
        chat_completion_source: 'deepseek',
        deepseek_model: 'deepseek-chat',
    });
    assert.equal(p.id, 'default');
    assert.equal(p.format, 'openai');
    assert.equal(p.baseUrl, 'https://api.deepseek.com/v1');
    assert.deepEqual(p.models.checked, ['deepseek-chat']);
    assert.equal(p.secretId, null); // 无 secrets 面 → null 占位
});

test('synthesizeLegacyProfile:claude 源 → anthropic 格式 + reverse_proxy 直通', () => {
    const p = synthesizeLegacyProfile({
        chat_completion_source: 'claude',
        claude_model: 'claude-sonnet-4',
        reverse_proxy: 'https://rp.example.com',
    });
    assert.equal(p.format, 'anthropic');
    assert.equal(p.baseUrl, 'https://rp.example.com');
    assert.deepEqual(p.models.checked, ['claude-sonnet-4']);
});

test('synthesizeLegacyProfile:custom 源取 custom_url;空配置 → 空档', () => {
    const p = synthesizeLegacyProfile({ chat_completion_source: 'custom', custom_url: 'https://c.example.com/v1', custom_model: 'x' });
    assert.equal(p.format, 'openai');
    assert.equal(p.baseUrl, 'https://c.example.com/v1');
    assert.deepEqual(p.models.checked, ['x']);
    const empty = synthesizeLegacyProfile({});
    assert.equal(empty.id, 'default');
    assert.equal(empty.baseUrl, '');
    assert.deepEqual(empty.models.checked, []);
    assert.deepEqual(empty.models.manual, []);
});

test('sanitizeProfileInput:upsert 归一化(保留 lastProbe/models 当未给)', () => {
    const existing = {
        id: 'p1', name: 'old', format: 'anthropic', baseUrl: 'b', secretId: 's',
        models: { checked: ['m'], manual: ['n'], lastProbe: { at: 1, ok: true, items: [] } },
    };
    // 空 body → 全保留
    assert.deepEqual(sanitizeProfileInput({}, { existing, id: 'p1' }), existing);
    // 部分写:name+disabled;models/lastProbe 不动
    const r = sanitizeProfileInput({ name: 'new', disabled: false }, { existing, id: 'p1' });
    assert.equal(r.name, 'new');
    assert.equal(r.disabled, false); // 显式 false 落 false(解除停用)
    // models 未给 → 保留含 lastProbe
    assert.deepEqual(r.models, existing.models);
    // models 给了 → checked/manual 覆盖;lastProbe 簿记保留;format 非法 → 沿用旧
    const r2 = sanitizeProfileInput({ format: 'nope', models: { checked: ['a'] } }, { existing, id: 'p1' });
    assert.equal(r2.format, 'anthropic');
    assert.deepEqual(r2.models.checked, ['a']);
    assert.equal(r2.models.manual.length, 0);
    assert.deepEqual(r2.models.lastProbe, existing.models.lastProbe);
});
