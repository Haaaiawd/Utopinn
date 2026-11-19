// useChatSession —— 阅读屏的宿主数据面(conversation-renderers.md §1 的
// RendererActions 移动端实现):send/swipe/edit/regen/branch/copy 全走既有
// utopinn 端点,协议零新增。
//
//   send      = POST messages → POST /generate → WS resume → delta 折进 live 层
//   swipe     = PATCH /body/<i>/swipe_id(乐观更新 + 服务端落账)
//   edit      = PATCH /body/<i>/mes(+激活 swipe 稿同改)
//   regen     = 末楼层:删层重生成(新回复落回原位);
//               中间层:生成 → PATCH 把新稿折进该层 swipes[](ST 语义)
//   branch    = PUT 新会话 + 追加 [0..i] 层
//   降级      = WS 断 → waitForPersistedReply 轮询落盘
import { useCallback, useEffect, useRef, useState } from 'react';
import { Clipboard } from 'react-native';
import type { MessageViewModel } from '@utopinn/protocol';
import {
    appendMessages,
    branchChat,
    getChat,
    patchChatOps,
    stToView,
    type JsonPatchOp,
    type StChatMessage,
} from '../api/client';
import { postGenerate, streamJob, waitForPersistedReply } from '../api/generate';

/** 与 apps/web 一致的用户名。 */
export const USER_NAME = '旅人';

export interface LiveFloor {
    floorId: number;
    name: string;
    /** 已落定的权威累计文本(WS 折出)。 */
    acc: string;
    /** 打字机定速已上屏的前缀(墨迹书写 R5:可定速,不可改写)。 */
    shown: string;
}

export interface ChatSession {
    messages: MessageViewModel[] | null;
    loadErr: string | null;
    hint: string | null;
    live: LiveFloor | null;
    busy: boolean;
    send: (text: string) => void;
    swipe: (floorId: number, index: number) => void;
    submitEdit: (floorId: number, text: string) => Promise<boolean>;
    regenerate: (floorId: number) => void;
    branch: (uptoIndex: number) => Promise<string>;
    copyFloor: (floorId: number) => void;
    dismissHint: () => void;
    /** 宿主侧提示条(分叉/导出等操作的回执)。 */
    note: (msg: string) => void;
    /** 会话级全文(导出用)。 */
    fullText: () => string;
}

export function useChatSession(charDir: string, chatName: string, charName: string): ChatSession {
    const [messages, setMessages] = useState<MessageViewModel[] | null>(null);
    const [st, setSt] = useState<StChatMessage[]>([]);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    const [hint, setHint] = useState<string | null>(null);
    const [live, setLive] = useState<LiveFloor | null>(null);
    const [busy, setBusy] = useState(false);
    const nextId = useRef(0);
    const abortRef = useRef<(() => void) | null>(null);

    const applyServer = useCallback((msgs: StChatMessage[]) => {
        const views = msgs.map((m, i) => stToView(m, i));
        nextId.current = views.length;
        setMessages(views);
        setSt(msgs);
    }, []);

    // 初始装载
    useEffect(() => {
        let dead = false;
        getChat(charDir, chatName)
            .then((d) => {
                if (!dead) applyServer(d.messages ?? []);
            })
            .catch((e) => {
                if (!dead) setLoadErr(e instanceof Error ? e.message : String(e));
            });
        return () => {
            dead = true;
        };
    }, [charDir, chatName, applyServer]);

    useEffect(() => () => abortRef.current?.(), []);

    // ── 墨迹定速:acc 是权威,shown 按节奏追 —— 落后太多会加速赶上 ──
    useEffect(() => {
        if (!live) return;
        const t = setInterval(() => {
            setLive((l) => {
                if (!l || l.shown.length >= l.acc.length) return l;
                const lag = l.acc.length - l.shown.length;
                const step = lag > 240 ? lag - 120 : Math.min(lag, Math.max(1, Math.ceil(lag / 5)));
                return { ...l, shown: l.acc.slice(0, l.shown.length + step) };
            });
        }, 50);
        return () => clearInterval(t);
    }, [live != null]); // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * 回读权威楼层(end 帧 → 落盘有毫秒级竞态):重试到楼层数达 expectLen
     * 或次数用尽,然后应用最后一次读到的。
     */
    const reload = useCallback(
        async (expectLen: number) => {
            let lastRead: StChatMessage[] | null = null;
            for (let i = 0; i < 10; i++) {
                try {
                    const d = await getChat(charDir, chatName);
                    lastRead = d.messages ?? [];
                    if (lastRead.length >= expectLen) break;
                } catch {
                    /* keep retrying */
                }
                await new Promise((r) => setTimeout(r, 600));
            }
            if (lastRead) {
                applyServer(lastRead);
                if (lastRead.length < expectLen) setHint('已生成,但回读楼层不全——重进可刷新');
            } else {
                setHint('已生成,但回读失败——重进可刷新');
            }
            setLive(null);
            setBusy(false);
        },
        [charDir, chatName, applyServer],
    );

    /**
     * 跑一次服务端生成并把 delta 折进 live 层。
     * onEnd 语义交给调用方(send→回读两层;regen→看情形)。
     */
    const runGenerate = useCallback(
        async (expectLenOnEnd: number, onEnd?: () => void) => {
            const jobId = (await postGenerate({
                charDir, chatName, type: 'normal', user: { name: USER_NAME },
            })).jobId;
            setLive({ floorId: nextId.current++, name: charName, acc: '', shown: '' });
            const fallback = async (why: string) => {
                const msgs = await waitForPersistedReply(charDir, chatName, expectLenOnEnd - 1);
                if (msgs) {
                    applyServer(msgs);
                    setHint(`流式中断(${why}),已从落盘恢复`);
                } else {
                    setHint(`生成中断(${why}):未等到落盘回复`);
                }
                setLive(null);
                setBusy(false);
            };
            try {
                abortRef.current = await streamJob(jobId, {
                    onDelta: (acc) => setLive((l) => (l ? { ...l, acc } : l)),
                    onEnd: () => {
                        setLive((l) => (l ? { ...l, shown: l.acc } : l));
                        if (onEnd) onEnd(); else void reload(expectLenOnEnd);
                    },
                    onError: (msg) => {
                        if (msg === 'ws_error' || msg === 'ws_closed') {
                            void fallback(msg);
                        } else {
                            setHint(`生成出错:${msg}`);
                            void reload(expectLenOnEnd);
                        }
                    },
                });
            } catch (e) {
                await fallback(e instanceof Error ? e.message : String(e));
            }
        },
        [charDir, chatName, charName, applyServer, reload],
    );

    const send = useCallback((text: string) => {
        if (live || messages === null) return;
        abortRef.current?.();
        setBusy(true);
        setHint(null);
        const baseCount = messages.length;
        setMessages((prev) => [
            ...(prev ?? []),
            { id: nextId.current++, role: 'user', name: USER_NAME, content: text, timestamp: Date.now() },
        ]);
        void (async () => {
            try {
                await appendMessages(charDir, chatName, [
                    { name: USER_NAME, is_user: true, mes: text, send_date: Date.now(), extra: {} },
                ]);
                await runGenerate(baseCount + 2);
            } catch (e) {
                setBusy(false);
                setLive(null);
                setHint(`发送失败:${e instanceof Error ? e.message : String(e)}`);
            }
        })();
    }, [charDir, chatName, live, messages, runGenerate]);

    const swipe = useCallback((floorId: number, index: number) => {
        setMessages((prev) => prev?.map((m) => {
            if (m.id !== floorId || !m.swipes?.[index]) return m;
            const s = m.swipes[index]!;
            return { ...m, activeSwipe: index, content: s.content, reasoning: s.reasoning, receipts: s.receipts ?? m.receipts };
        }) ?? prev);
        patchChatOps(charDir, chatName, [{ op: 'replace', path: `/body/${floorId}/swipe_id`, value: index }])
            .catch((e) => setHint(`选稿失败:${e instanceof Error ? e.message : String(e)}`));
    }, [charDir, chatName]);

    const submitEdit = useCallback(async (floorId: number, text: string): Promise<boolean> => {
        const raw = st[floorId];
        const ops: JsonPatchOp[] = [{ op: 'replace', path: `/body/${floorId}/mes`, value: text }];
        if (raw && Array.isArray(raw.swipes)) {
            const a = Math.min(Number(raw.swipe_id ?? 0), raw.swipes.length - 1);
            const entry = raw.swipes[a];
            ops.push(typeof entry === 'string'
                ? { op: 'replace', path: `/body/${floorId}/swipes/${a}`, value: text }
                : { op: 'replace', path: `/body/${floorId}/swipes/${a}/mes`, value: text });
        }
        try {
            await patchChatOps(charDir, chatName, ops);
            setMessages((prev) => prev?.map((m) => {
                if (m.id !== floorId) return m;
                const swipes = m.swipes?.map((s) => (s.index === (m.activeSwipe ?? 0) ? { ...s, content: text } : s));
                return { ...m, content: text, swipes };
            }) ?? prev);
            return true;
        } catch (e) {
            setHint(`保存失败:${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }, [charDir, chatName, st]);

    /**
     * 重写此段:
     *  - 末层 assistant → PATCH 删层 → 生成(新回复恰好落回原位)
     *  - 中间层 → 生成(上下文含旧稿,是已知近似)→ 落盘后 PATCH 把新稿
     *    折进该层 swipes[] 并删掉尾部附加层 —— 产物=该层多一稿,与 ST 语义一致
     */
    const regenerate = useCallback((floorId: number) => {
        if (live || messages === null) return;
        const idx = messages.findIndex((m) => m.id === floorId);
        const floor = messages[idx];
        if (!floor || floor.role !== 'assistant') return;
        abortRef.current?.();
        setBusy(true);
        setHint(null);
        const isLast = idx === messages.length - 1;
        void (async () => {
            try {
                if (isLast) {
                    await patchChatOps(charDir, chatName, [{ op: 'remove', path: `/body/${idx}` }]);
                    setMessages((prev) => (prev ?? []).filter((m) => m.id !== floorId));
                    await runGenerate(idx + 1);
                } else {
                    await runGenerate(st.length + 1, () => void foldNewestIntoSwipe(floorId));
                }
            } catch (e) {
                setBusy(false);
                setLive(null);
                setHint(`重写失败:${e instanceof Error ? e.message : String(e)}`);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [charDir, chatName, live, messages, st, runGenerate]);

    /** 把服务端追加在末尾的新楼层折进 floorId 的 swipes 链(ST 线格式)。 */
    const foldNewestIntoSwipe = useCallback(async (floorId: number) => {
        try {
            const detail = await getChat(charDir, chatName);
            const body = detail.messages ?? [];
            const lastIdx = body.length - 1;
            const newest = body[lastIdx];
            if (!newest || lastIdx < 0 || floorId >= lastIdx) {
                applyServer(body);
                return;
            }
            const newText = String(newest.mes ?? '');
            const target = body[floorId];
            const ops: JsonPatchOp[] = [];
            if (target && Array.isArray(target.swipes) && target.swipes.length) {
                ops.push({ op: 'add', path: `/body/${floorId}/swipes/-`, value: { mes: newText, send_date: newest.send_date ?? Date.now() } });
                ops.push({ op: 'replace', path: `/body/${floorId}/swipe_id`, value: target.swipes.length });
            } else {
                const oldText = String(target?.mes ?? '');
                ops.push({ op: 'add', path: `/body/${floorId}/swipes`, value: [
                    { mes: oldText, send_date: target?.send_date ?? Date.now() },
                    { mes: newText, send_date: newest.send_date ?? Date.now() },
                ] });
                ops.push({ op: 'add', path: `/body/${floorId}/swipe_id`, value: 1 });
            }
            ops.push({ op: 'replace', path: `/body/${floorId}/mes`, value: newText });
            ops.push({ op: 'remove', path: `/body/${lastIdx}` });
            await patchChatOps(charDir, chatName, ops);
            const after = await getChat(charDir, chatName);
            applyServer(after.messages ?? []);
            setHint(null);
        } catch (e) {
            setHint(`重写落稿失败:${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setLive(null);
            setBusy(false);
        }
    }, [charDir, chatName, applyServer]);

    const branch = useCallback(async (uptoIndex: number): Promise<string> => {
        const d = new Date();
        const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
        const newName = `${chatName} 分岔 ${stamp}`.slice(0, 120);
        await branchChat(charDir, chatName, uptoIndex, newName);
        return newName;
    }, [charDir, chatName]);

    const copyFloor = useCallback((floorId: number) => {
        const m = messages?.find((x) => x.id === floorId);
        if (!m) return;
        Clipboard.setString(m.displayContent ?? m.content);
        setHint('已复制这一段');
    }, [messages]);

    const fullText = useCallback((): string => {
        return (messages ?? [])
            .filter((m) => m.role !== 'system')
            .map((m) => m.displayContent ?? m.content)
            .join('\n\n');
    }, [messages]);

    return {
        messages, loadErr, hint, live, busy,
        send, swipe, submitEdit, regenerate, branch, copyFloor, fullText,
        dismissHint: () => setHint(null),
        note: (msg: string) => setHint(msg),
    };
}
