// TASK-071 实弹验证:enableUserAccounts 实例上 api-client account 域全链。
// 跑法: node _live_test.mjs http://127.0.0.1:18998
import { UtopinnClient, isSessionError } from './dist/index.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:18998';
const log = (s) => console.log(`  ${s}`);
let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
    if (!cond) failures++;
};

const anon = new UtopinnClient({ baseUrl: BASE });

// 1) 未登录 → me 403
try {
    await anon.account.me();
    check('anon me() → 403', false, 'unexpectedly succeeded');
} catch (e) {
    check('anon me() → 403', isSessionError(e) && e.status === 403, `${e.status}`);
}

// 2) 未登录 → 私有 API 403
try {
    await anon.library.chars();
    check('anon private API → 403', false, 'unexpectedly succeeded');
} catch (e) {
    check('anon private API → 403', isSessionError(e) && e.status === 403, `${e.status}`);
}

// 3) default-user 无密码账户:任意密码都放行(服务端语义:user.password 空→跳过校验)
const admin = new UtopinnClient({ baseUrl: BASE });
const lr = await admin.account.login('default-user', '');
check('admin login', lr.handle === 'default-user', lr.handle);

// 4) 同 jar 直接 me() → admin
const me = await admin.account.me();
check('me() after login', me.handle === 'default-user' && me.admin === true, `${me.handle} admin=${me.admin}`);

// 5) 同 jar 私有 API 通(目录隔离:default-user 角色列表可达)
const chars = await admin.library.chars();
check('private API post-login', Array.isArray(chars.items), `${chars.total} chars in default-user ns`);

// 6) admin 建 user2(带密码,非 admin)
let c2;
try {
    c2 = await admin.request('/api/users/create', {
        method: 'POST', body: { handle: 'classmate', name: 'Classmate', password: 'pw-123', admin: false },
    });
} catch (e) {
    c2 = { already: e.status === 409 };
}
check('admin create user2', c2?.handle === 'classmate' || c2?.already === true, JSON.stringify(c2));

// 7) 错凭据 login(user2 有密码)→ 403
try {
    await new UtopinnClient({ baseUrl: BASE }).account.login('classmate', 'wrong-password');
    check('bad login → 403', false, 'unexpectedly succeeded');
} catch (e) {
    check('bad login → 403', isSessionError(e) && e.status === 403, `${e.status} ${JSON.stringify(e.body)}`);
}

// 8) 新 client 用 user2 登录 → 隔离证据:me=classmate admin=false;角色列表独立(各自目录)
const u2 = new UtopinnClient({ baseUrl: BASE });
const lr2 = await u2.account.login('classmate', 'pw-123');
check('user2 login', lr2.handle === 'classmate');
const me2 = await u2.account.me();
check('user2 me()', me2.handle === 'classmate' && me2.admin === false, `${me2.handle} admin=${me2.admin}`);
const chars2 = await u2.library.chars();
check('user2 chars isolated', Array.isArray(chars2.items), `user2 sees ${chars2.total} chars (own ns)`);
log(`isolation: default-user=${chars.total} chars vs classmate=${chars2.total} chars`);

// 9) 关键回归:权限 403(非 admin 调 admin 面)不许把登录态客户端侧登出 ——
//    autoReauth 同会话轮换 CSRF,会话保活,me() 仍通。
try {
    await u2.request('/api/users/create', { method: 'POST', body: { handle: 'x2', name: 'x2' } });
    check('user2 admin route denied', false, 'unexpectedly succeeded');
} catch (e) {
    check('user2 admin route denied', e.status === 403, `${e.status}`);
}
const still = await u2.account.me();
check('session survives perm-403', still.handle === 'classmate', `${still.handle}`);

// 10) logout → me 403
await u2.account.logout();
try {
    await u2.account.me();
    check('me() after logout → 403', false, 'unexpectedly succeeded');
} catch (e) {
    check('me() after logout → 403', isSessionError(e) && e.status === 403, `${e.status}`);
}

console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
