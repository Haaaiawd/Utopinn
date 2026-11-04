// 聊天屏 — 薄客户端主链路:
//   发送 = POST messages 塞用户层 → POST /api/uberge/generate → jobId
//        → ws-ticket → WS resume from_seq:1 → chunk(base64 SSE)→析 delta→流式拼气泡
//        → end 帧后 GET chat 回读权威楼层(防丢字)
//   降级 = WS 起不来/中途断 → waitForPersistedReply 轮询落盘楼层,不死等。
// 组装、世界书、正则管线全在服务端;这里只有渲染与转发。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams } from 'expo-router';
import { LegendList } from '@legendapp/list/react-native';
import type { MessageViewModel } from '@uberge/protocol';
import { appendMessages, getChat, stToView, type StChatMessage } from '../../../src/api/client';
import { postGenerate, streamJob, waitForPersistedReply } from '../../../src/api/generate';
import { colors } from '../../../src/ui/theme';

/** 与 apps/web 一致的用户名(同一份楼层数据跨端一致)。 */
const USER_NAME = '旅人';

function fmtTs(ts?: string | number): string {
    if (ts == null) return '';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Bubble({ m }: { m: MessageViewModel }) {
    if (m.role === 'system') {
        return m.content ? <Text style={styles.sys}>{m.content}</Text> : null;
    }
    const isUser = m.role === 'user';
    return (
        <View style={[styles.bubbleRow, isUser && styles.bubbleRowUser]}>
            <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleChar]}>
                <Text style={styles.bubbleName}>{m.name || (isUser ? USER_NAME : '?')}</Text>
                <Text style={styles.bubbleText}>
                    {m.content}
                    {m.streaming ? '▍' : ''}
                </Text>
                <Text style={styles.bubbleTime}>{fmtTs(m.timestamp)}</Text>
            </View>
        </View>
    );
}

export default function ChatScreen() {
    const { charDir, chatName, name } = useLocalSearchParams<{ charDir: string; chatName: string; name?: string }>();
    const charName = name || charDir!;
    const insets = useSafeAreaInsets();
    const [messages, setMessages] = useState<MessageViewModel[] | null>(null);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    const [hint, setHint] = useState<string | null>(null);
    const [streaming, setStreaming] = useState(false);
    const [draft, setDraft] = useState('');
    const nextId = useRef(0);
    const abortRef = useRef<(() => void) | null>(null);

    const applyServer = useCallback((msgs: StChatMessage[]) => {
        const views = msgs.map((m, i) => stToView(m, i));
        nextId.current = views.length;
        setMessages(views);
    }, []);

    // 初始装载
    useEffect(() => {
        let dead = false;
        getChat(charDir!, chatName!)
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

    // 卸载时关掉在飞的 WS
    useEffect(() => () => abortRef.current?.(), []);

    /**
     * 回读权威楼层(end 帧 → 落盘可能有毫秒级竞态):短重试直到楼层数
     * 达到 expectLen(用户层+回复层)再应用;超时就用最后一次读到的。
     */
    const reload = useCallback(
        async (expectLen: number) => {
            let lastRead: StChatMessage[] | null = null;
            for (let i = 0; i < 10; i++) {
                try {
                    const d = await getChat(charDir!, chatName!);
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
            setStreaming(false);
        },
        [charDir, chatName, applyServer],
    );

    const sendLive = async (text: string) => {
        abortRef.current?.();
        setStreaming(true);
        setHint(null);
        const baseCount = (messages ?? []).length; // 服务端用户楼层下标
        setMessages((prev) => [
            ...(prev ?? []),
            { id: nextId.current++, role: 'user', name: USER_NAME, content: text, timestamp: Date.now() },
        ]);
        const floorId = nextId.current++;
        const upsertFloor = (content: string) =>
            setMessages((prev) => {
                const floor: MessageViewModel = { id: floorId, role: 'assistant', name: charName, content, streaming: true };
                const i = (prev ?? []).findIndex((m) => m.id === floorId);
                return i < 0 ? [...(prev ?? []), floor] : (prev ?? []).map((m) => (m.id === floorId ? floor : m));
            });

        // ── 发送阶段:失败即报错,没有 job 可等 ──
        let jobId: string;
        try {
            await appendMessages(charDir!, chatName!, [
                { name: USER_NAME, is_user: true, mes: text, send_date: Date.now(), extra: {} },
            ]);
            jobId = (await postGenerate({
                charDir: charDir!,
                chatName: chatName!,
                type: 'normal',
                user: { name: USER_NAME },
            })).jobId;
        } catch (e) {
            setStreaming(false);
            setHint(`发送失败:${e instanceof Error ? e.message : String(e)}`);
            return;
        }

        // ── 流式阶段:WS 断了 → 轮询落盘(job 结束后服务端已持久化)──
        const fallback = async (why: string) => {
            const msgs = await waitForPersistedReply(charDir!, chatName!, baseCount + 1);
            if (msgs) {
                applyServer(msgs);
                setHint(`流式中断(${why}),已从落盘恢复`);
            } else {
                setHint(`生成中断(${why}):未等到落盘回复`);
            }
            setStreaming(false);
        };

        try {
            abortRef.current = await streamJob(jobId, {
                onDelta: (acc) => upsertFloor(acc),
                onEnd: () => void reload(baseCount + 2),
                onError: (msg) => {
                    // 'error' 帧 = job 服务端失败 → 直接回读磁盘;
                    // ws_error/ws_closed = 传输断了 → 轮询等落盘
                    if (msg === 'ws_error' || msg === 'ws_closed') {
                        void fallback(msg);
                    } else {
                        setHint(`生成出错:${msg}`);
                        void reload(baseCount + 1);
                    }
                },
            });
        } catch (e) {
            await fallback(e instanceof Error ? e.message : String(e));
        }
    };

    const send = () => {
        const text = draft.trim();
        if (!text || streaming || messages === null) return;
        setDraft('');
        void sendLive(text);
    };

    return (
        <KeyboardAvoidingView
            style={styles.root}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
            <Stack.Screen options={{ title: chatName ?? '对话' }} />
            {hint ? (
                <Pressable style={styles.hintBar} onPress={() => setHint(null)}>
                    <Text style={styles.hintText}>{hint}</Text>
                </Pressable>
            ) : null}
            {messages === null ? (
                <View style={styles.center}>
                    {loadErr ? <Text style={styles.errText}>{loadErr}</Text> : <ActivityIndicator color={colors.sub} />}
                </View>
            ) : (
                <LegendList
                    data={messages}
                    keyExtractor={(m) => String(m.id)}
                    renderItem={({ item }) => <Bubble m={item} />}
                    estimatedItemSize={72}
                    initialScrollAtEnd
                    maintainScrollAtEnd
                    alignItemsAtEnd
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                        <View style={styles.center}>
                            <Text style={styles.emptyText}>打个招呼吧</Text>
                        </View>
                    }
                />
            )}
            <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
                <TextInput
                    style={styles.input}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={streaming ? '生成中…' : '说点什么…'}
                    placeholderTextColor={colors.dim}
                    multiline
                    editable={!streaming && messages !== null}
                    onSubmitEditing={send}
                    blurOnSubmit
                />
                <Pressable
                    style={[styles.sendBtn, (streaming || !draft.trim()) && styles.sendBtnDim]}
                    onPress={send}
                    disabled={streaming || !draft.trim()}
                >
                    <Text style={styles.sendBtnText}>发送</Text>
                </Pressable>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    errText: { color: colors.err, fontSize: 14, textAlign: 'center' },
    emptyText: { color: colors.dim, fontSize: 14 },
    listContent: { paddingHorizontal: 12, paddingVertical: 10, flexGrow: 1 },
    hintBar: {
        backgroundColor: colors.cardAlt,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    hintText: { color: colors.warn, fontSize: 12 },
    sys: { color: colors.dim, fontSize: 12, textAlign: 'center', marginVertical: 8, paddingHorizontal: 24 },
    bubbleRow: { flexDirection: 'row', marginVertical: 4 },
    bubbleRowUser: { justifyContent: 'flex-end' },
    bubble: { maxWidth: '82%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9 },
    bubbleChar: { backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderTopLeftRadius: 4 },
    bubbleUser: { backgroundColor: colors.userBubble, borderTopRightRadius: 4 },
    bubbleName: { color: colors.sub, fontSize: 11, marginBottom: 3 },
    bubbleText: { color: colors.text, fontSize: 15, lineHeight: 22 },
    bubbleTime: { color: colors.dim, fontSize: 10, marginTop: 4, alignSelf: 'flex-end' },
    composer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 8,
        paddingHorizontal: 12,
        paddingTop: 8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border,
        backgroundColor: colors.bgAlt,
    },
    input: {
        flex: 1,
        maxHeight: 120,
        backgroundColor: colors.card,
        borderRadius: 18,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        color: colors.text,
        paddingHorizontal: 14,
        paddingTop: 9,
        paddingBottom: 9,
        fontSize: 15,
    },
    sendBtn: { backgroundColor: colors.accent, borderRadius: 18, paddingHorizontal: 18, paddingVertical: 10 },
    sendBtnDim: { opacity: 0.4 },
    sendBtnText: { color: '#0b0e14', fontWeight: '700', fontSize: 14 },
});
