/**
 * script_injects 生命周期消费 — Luker consumeEphemeralScriptInjects-
 * ForMainGeneration 的服务端落点。
 *
 * 上游:非 quiet 生成生命周期终态(hideStopButton)清 ephemeral 标记的
 * chat_metadata.script_injects;quiet/辅助生成不得消费。
 *
 * 服务端差异:
 * - 写面走 repo CAS 读-改-写(updateChatMetadata expectedIntegrity),
 *   只删「消费时点存活图里仍 ephemeral」的条目 —— 生成途中并发写进的
 *   新 inject、被重建/替换的同 id 条目随 integrity 校验存活,不拿
 *   assemble 时快照整图回写(那会把并发新增擦掉/复活已删条目)。
 * - 触发点挂 job 终态(awaiting_ack / failed / cancelled):
 *   upstream hideStopButton 对应「生成结束」,与服务端持久化解耦,
 *   先于落楼消费与上游同序;兜底 persist/ack 之后的状态不再重复清。
 */

import path from 'node:path';
import sanitize from 'sanitize-filename';

import { getChatRepo } from '../storage/index.js';
import { emit as diagEmit } from './diag-bus.js';

const CONSUME_CAS_ATTEMPTS = 4;

/**
 * 从 live chat_metadata 原子移除全部 ephemeral inject(CAS 重试)。
 * @param {object} args
 * @param {string} args.handle
 * @param {string} args.charDir
 * @param {string} args.chatName
 * @param {boolean} [args.isGroup]
 * @param {string} [args.groupId]
 * @returns {Promise<number>} 删除的条目数
 */
export async function consumeEphemeralScriptInjectsForChat({ handle, charDir, chatName, isGroup = false, groupId } = {}) {
    if (!handle || !chatName) return 0;
    const repo = getChatRepo();
    for (let attempt = 0; attempt < CONSUME_CAS_ATTEMPTS; attempt++) {
        const doc = await repo.get(handle, charDir ?? '', chatName, { isGroup, groupId });
        const store = doc?.header?.chat_metadata?.script_injects;
        if (!store || typeof store !== 'object') return 0;
        const ids = Object.keys(store).filter((id) => store[id]?.ephemeral === true);
        if (!ids.length) return 0;
        const next = { ...store };
        for (const id of ids) delete next[id];
        try {
            await repo.updateChatMetadata(handle, charDir ?? '', chatName,
                { script_injects: next }, doc.integrity, { isGroup, groupId });
            return ids.length;
        } catch (error) {
            // CAS 撞档 → 重读重试;非并发错误(聊天没了等)如实冒泡给调用方。
            if (error?.name !== 'ConflictError') throw error;
        }
    }
    console.warn('[script-injects] ephemeral consume: CAS retries exhausted for', charDir, chatName);
    return 0;
}

/**
 * job 终态门:非 quiet 生成结束(awaiting_ack/failed/cancelled)时消费
 * ephemeral inject。verb 'quiet' 与无持久目标的 job 不消费(上游
 * activeGenerationTypeForStopButton !== 'quiet' 门闩同口径)。
 * fire-and-forget:不阻塞 job 状态迁移,失败仅 warn。
 * @param {object} job 生成任务(persistTarget/requestMeta/handle)
 */
export function consumeEphemeralScriptInjectsForJob(job) {
    const verb = String(job?.requestMeta?.verb ?? '');
    if (verb === 'quiet') return;
    const persistTarget = job?.persistTarget;
    if (!persistTarget || typeof persistTarget !== 'object') return;
    const handle = String(job?.handle ?? '');
    if (!handle) return;

    let target = null;
    if (persistTarget.kind === 'character') {
        // 与 persistGeneratedReply character 分支同寻址:
        // normalizePersistAvatarDirectory/JsonlFileName 同式
        // (basename + sanitize),file_name 去 .jsonl 后缀。
        const rawAvatar = String(persistTarget.avatar_url ?? '').replace('.png', '').trim();
        const rawFile = String(persistTarget.file_name ?? '').replace(/\.jsonl$/i, '').trim();
        const charDir = rawAvatar ? sanitize(path.basename(rawAvatar)) : '';
        const chatName = rawFile ? sanitize(path.basename(rawFile)) : '';
        if (charDir && chatName) {
            target = { handle, charDir, chatName, isGroup: false };
        }
    } else if (persistTarget.kind === 'group') {
        const groupId = String(persistTarget.id ?? '').trim();
        if (groupId) {
            target = { handle, charDir: '', chatName: groupId, isGroup: true, groupId };
        }
    }
    if (!target) return;

    void consumeEphemeralScriptInjectsForChat(target)
        .then((removed) => {
            if (removed > 0) {
                diagEmit({
                    lvl: 'info', kind: 'generate', code: 'injects_ephemeral_consumed',
                    msg: `consumed ${removed} ephemeral inject(s) for ${target.chatName}`,
                    ctx: { jobId: job.id, chatKey: job.chatKey, verb },
                });
            }
        })
        .catch((error) => {
            console.warn('[script-injects] ephemeral consume failed:', error?.message ?? error);
        });
}
