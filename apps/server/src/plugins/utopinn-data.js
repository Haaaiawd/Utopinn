/**
 * utopinn-data —— TASK-016 补刀:备份快照 + ST 目录扫描 + LAN 发现。
 *
 *   POST /api/utopinn/backup          备份快照:createBackupArchive 复用
 *                                    users.js 全量归档机(selection 分类可选)
 *   POST /api/utopinn/import/scan-st  {dir} 扫 ST default-user 目录 →
 *                                    可导入清单(characters/worlds/presets/
 *                                    quickReplies/personas/themes)
 *   POST /api/utopinn/lan/offer       {handle,selection} → {url,expiresAt}
 *                                    与 legacy /api/users/lan-migration/offer 同语义
 *   POST /api/utopinn/lan/import      {handle,url,selection,mode} →
 *                                    loopback 代理到 legacy 流式 import(不复制语义)
 *   UDP <httpPort>                   LAN 发现:对 'utopinn-discover' /
 *                                    {"probe":"utopinn"} 探头回 JSON pong;
 *                                    socket 挂 ctx.effect,插件 dispose 即收
 *
 * 备份面只代理——归档/恢复重活在 legacy users-private 面上,不重复造。
 */
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import os from 'node:os';
import { createBackupArchive, normalizeUserBackupSelection } from '../users.js';
import { createLanMigrationOffer, LAN_MIGRATION_PATH_PREFIX } from '../lan-migration.js';
import { getRequestBaseUrl } from '../express-common.js';
import { getConfigValue } from '../util.js';

export const inject = ['webServer'];

/** ST default-user 数据目录 → 可导入类别映射。 */
const ST_DIRS = [
    ['characters', ['.png'], 'character'],
    ['worlds', ['.json'], 'world'],
    ['Worlds', ['.json'], 'world'],
    ['QuickReplies', ['.json'], 'quickReply'],
    ['OpenAI Settings', ['.json'], 'preset'],
    ['TextGen Settings', ['.json'], 'preset'],
    ['NovelAI Settings', ['.json'], 'preset'],
    ['KoboldAI Settings', ['.json'], 'preset'],
    ['User Avatars', ['.png', '.jpg', '.jpeg', '.webp'], 'persona'],
    ['themes', ['.json'], 'theme'],
];

async function scanStDir(root) {
    const items = [];
    for (const [sub, exts, kind] of ST_DIRS) {
        const dir = path.join(root, sub);
        let files;
        try {
            files = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue; // 缺子目录是常态 —— ST 目录不一定长全
        }
        for (const f of files) {
            if (!f.isFile()) continue;
            if (!exts.includes(path.extname(f.name).toLowerCase())) continue;
            const fp = path.join(dir, f.name);
            const size = (await fs.promises.stat(fp).catch(() => null))?.size ?? 0;
            items.push({ kind, name: path.basename(f.name, path.extname(f.name)), file: fp, bytes: size });
        }
    }
    return items;
}

export function apply(ctx) {
    const reg = (path_, handler) =>
        ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path: path_, handler }));

    /** 备份快照——复用 createBackupArchive(handle,response,selection)。 */
    reg('/api/utopinn/backup', async function (request, response) {
        try {
            const selection = request.body?.selection && typeof request.body.selection === 'object'
                ? request.body.selection : undefined;
            await createBackupArchive(request.user.profile.handle, response, selection);
        } catch (error) {
            console.error('[utopinn/backup] failed:', error);
            if (!response.headersSent) return response.status(500).send({ error: 'backup failed' });
        }
    });

    /** LAN 迁移 offer——与 legacy 同语义:selection 消毒 + token + offer URL。 */
    reg('/api/utopinn/lan/offer', async function (request, response) {
        const handle = String(request.body?.handle ?? request.user.profile.handle).trim();
        if (!handle) return response.status(400).send({ error: 'Missing required fields' });
        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            return response.status(403).send({ error: 'Unauthorized' });
        }
        const isAdmin = Boolean(request.user?.profile?.admin);
        let sel = request.body?.selection;
        if (typeof sel === 'string') { try { sel = JSON.parse(sel); } catch { sel = {}; } }
        const selection = normalizeUserBackupSelection(sel);
        if (!isAdmin) selection.globalExtensions = false;
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).send({ error: 'At least one backup category must be selected.' });
        }
        const { token, expiresAt } = createLanMigrationOffer({ handle, selection, includeGlobalExtensions: isAdmin });
        const url = `${getRequestBaseUrl(request).replace(/\/+$/, '')}${LAN_MIGRATION_PATH_PREFIX}${token}`;
        return response.send({ url, expiresAt });
    });

    /** LAN 迁移 import——薄代理:转发会话凭据到 legacy 流式端点,语义不复制。 */
    reg('/api/utopinn/lan/import', async function (request, response) {
        const port = Number(getConfigValue('port', 8000));
        const headers = { 'content-type': 'application/json' };
        for (const h of ['cookie', 'x-csrf-token', 'accept']) {
            if (request.headers[h]) headers[h] = request.headers[h];
        }
        let upstream;
        try {
            upstream = await fetch(`http://127.0.0.1:${port}/api/users/lan-migration/import`, {
                method: 'POST', headers, body: JSON.stringify(request.body ?? {}),
            });
        } catch (error) {
            return response.status(502).send({ error: `lan import upstream failed: ${error.message}` });
        }
        response.status(upstream.status);
        for (const h of ['content-type', 'content-disposition']) {
            const v = upstream.headers.get(h);
            if (v) response.setHeader(h, v);
        }
        const text = await upstream.text();
        return response.send(text);
    });

    /** ST 目录扫描——清单化,不导入;导入走 /import/preview+commit。 */
    reg('/api/utopinn/import/scan-st', async function (request, response) {
        if (!request.user?.profile?.admin) {
            return response.status(403).send({ error: 'Unauthorized' });
        }
        const dir = String(request.body?.dir ?? '').trim();
        if (!dir) return response.status(400).send({ error: 'dir is required' });
        const root = path.resolve(dir);
        const st = await fs.promises.stat(root).catch(() => null);
        if (!st?.isDirectory()) return response.status(404).send({ error: `not a directory: ${root}` });
        const items = await scanStDir(root);
        const counts = {};
        for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
        return response.send({ root, total: items.length, counts, items });
    });

    /** LAN 发现:UDP 绑在 HTTP 同端口(UDP/TCP 端口互不冲突)。 */
    ctx.effect(() => {
        const port = Number(getConfigValue('port', 8000));
        const socket = dgram.createSocket('udp4');
        socket.on('error', (e) => console.warn('[utopinn/discover] udp error:', e.message));
        socket.on('message', (msg, rinfo) => {
            const text = msg.toString('utf-8').trim();
            if (text !== 'utopinn-discover' && !text.includes('"utopinn"')) return;
            const payload = JSON.stringify({
                app: 'utopinn', name: os.hostname(),
                httpPort: port,
                version: process.env.npm_package_version ?? 'dev',
            });
            socket.send(payload, rinfo.port, rinfo.address, () => {});
        });
        socket.bind(port);
        console.log(`[utopinn/discover] udp responder on :${port}`);
        return () => { try { socket.close(); } catch { /* already closed */ } };
    });
}
