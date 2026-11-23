// 沉浸阅读器 —— 「小说阅读器」核心面(design §2):
//   正文全屏零 chrome;点中央 ~45% 呼出/收起(<200ms 淡入);
//   顶栏=返回+书名+章名+…;底栏双行=上一章/进度/下一章 + 目录/排式/Aa/夜间;
//   右下笔尖 FAB + 文末虚线占位 → 半屏书写层;长按段=操作菜单;
//   章节目录左抽屉;swipe=✦N稿 半屏候选;进度记本地(kl·mmkv)。
// 排版/分章/墨水全是宿主 chrome;消息语义全在 useChatSession(RendererActions)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Animated,
    Clipboard,
    Pressable,
    StyleSheet,
    Text,
    View,
    type GestureResponderEvent,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LegendListRef } from '@legendapp/list/react-native';
import type { MessageViewModel } from '@utopinn/protocol';
import { getCharacter, type CardInfo } from '../../../src/api/client';
import { useChatSession } from '../../../src/state/conversation';
import { reading, useReading } from '../../../src/state/reading';
import { buildChapters, buildParas, chapterAt, floorParas, type Para } from '../../../src/reader/format';
import { READER_THEMES } from '../../../src/reader/theme';
import { ProseFlow } from '../../../src/reader/ProseFlow';
import { BubbleFlow } from '../../../src/reader/BubbleFlow';
import { ChapterDrawer } from '../../../src/reader/ChapterDrawer';
import { SwipeSheet } from '../../../src/reader/SwipeSheet';
import { ParaMenu, type ParaAction } from '../../../src/reader/ParaMenu';
import { EditSheet } from '../../../src/reader/EditSheet';
import { ComposeSheet } from '../../../src/reader/ComposeSheet';
import { AaPanel } from '../../../src/reader/AaPanel';
import { CardSheet } from '../../../src/reader/CardSheet';
import { useSession } from '../../../src/state/session';

const TAP_MS = 260;
const TAP_PX = 14;
const CENTER_L = 0.275; // 左缘 ~28%
const CENTER_R = 0.725; // 中央 ~45%

export default function ReaderScreen() {
    const { charDir, chatName, name, at } = useLocalSearchParams<{
        charDir: string; chatName: string; name?: string; at?: string;
    }>();
    const charName = name || charDir!;
    const chatKey = `${charDir}/${chatName}`;
    const insets = useSafeAreaInsets();
    const conn = useSession();

    const session = useChatSession(charDir!, chatName!, charName);
    const store = useReading();
    const settings = store.settings;
    const theme = READER_THEMES[settings.theme];

    const listRef = useRef<LegendListRef | null>(null);
    const progressW = useRef(1);
    const [viewPara, setViewPara] = useState(0);
    const [chrome, setChrome] = useState(false);
    const [hintShown, setHintShown] = useState(false);

    // sheets / drawers
    const [menuFloor, setMenuFloor] = useState<MessageViewModel | null>(null);
    const [swipeFloor, setSwipeFloor] = useState<MessageViewModel | null>(null);
    const [editFloor, setEditFloor] = useState<MessageViewModel | null>(null);
    const [composeOpen, setComposeOpen] = useState(false);
    const [aaOpen, setAaOpen] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [overflowOpen, setOverflowOpen] = useState(false);
    const [cardOpen, setCardOpen] = useState(false);
    const [card, setCard] = useState<CardInfo | null>(null);
    const [cardLoading, setCardLoading] = useState(false);
    const [busyNote, setBusyNote] = useState<string | null>(null);

    // ---------- 段落流 + 章 ----------

    const baseParas = useMemo(() => buildParas(session.messages ?? []), [session.messages]);
    const liveFloor = session.live;
    const paras = useMemo<Para[]>(() => {
        if (!liveFloor) return baseParas;
        const m: MessageViewModel = {
            id: liveFloor.floorId, role: 'assistant', name: liveFloor.name,
            content: liveFloor.shown, streaming: true,
        };
        const parts = floorParas(m);
        const extra = parts.map((t, i): Para => ({
            key: `live:${i}`,
            index: baseParas.length + i,
            floorId: m.id,
            role: 'assistant',
            text: t,
            floor: m,
            isFloorFirst: i === 0,
            isFloorLast: i === parts.length - 1,
        }));
        return [...baseParas, ...extra];
    }, [baseParas, liveFloor]);
    const chapters = useMemo(() => buildChapters(paras), [paras]);
    const curChapter = chapterAt(chapters, viewPara);
    const curChapterIdx = curChapter?.index ?? 0;

    // ---------- 进度恢复 + 记录 ----------

    const restoreIndex = useMemo(() => {
        // at = 显式段下标(书页「从头读」=0、目录跳章=paraStart);缺省=上次位置
        if (at != null) {
            const n = Number(at);
            if (!Number.isNaN(n)) return Math.max(0, Math.round(n));
        }
        const p = reading.progress(chatKey);
        return p && p.para > 0 ? p.para : undefined;
        // 只在进屏时算一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatKey]);

    const lastSaved = useRef(0);
    useEffect(() => {
        const now = Date.now();
        if (now - lastSaved.current < 1500) return;
        lastSaved.current = now;
        reading.setProgress(chatKey, viewPara, (session.messages ?? []).length);
    }, [viewPara, chatKey, session.messages]);

    // ---------- chrome 呼出/收起(点中央 ~45%) ----------

    const chromeAnim = useRef(new Animated.Value(0)).current;
    useEffect(() => {
        Animated.timing(chromeAnim, { toValue: chrome ? 1 : 0, duration: 160, useNativeDriver: true }).start();
    }, [chrome, chromeAnim]);

    // 首进一次性提示
    useEffect(() => {
        if (!reading.chromeHintSeen && session.messages != null) setHintShown(true);
    }, [session.messages]);
    const dismissHint = useCallback(() => {
        setHintShown(false);
        reading.markChromeHintSeen();
    }, []);

    const jumpTo = useCallback((paraIndex: number) => {
        listRef.current?.scrollToIndex({ index: paraIndex, animated: false });
        setViewPara(paraIndex);
    }, []);

    const turnChapter = useCallback((dir: -1 | 1) => {
        const next = curChapterIdx + dir;
        if (next < 0 || next >= chapters.length) return;
        jumpTo(chapters[next]!.paraStart);
    }, [curChapterIdx, chapters, jumpTo]);

    // 触区判定:父 View onTouchStart/End 冒泡拿坐标 —— 不抢段落的 responder,
    // 所以长按/角标点按依旧工作(比覆盖层干净)。
    const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);
    const zoneW = useRef(1);
    const onTouchStart = (e: GestureResponderEvent) => {
        touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, t: Date.now() };
    };
    const onTouchEnd = (e: GestureResponderEvent) => {
        const s = touchStart.current;
        touchStart.current = null;
        if (!s || session.messages === null) return;
        const dx = e.nativeEvent.pageX - s.x;
        const dy = e.nativeEvent.pageY - s.y;
        if (Date.now() - s.t > TAP_MS || Math.abs(dx) > TAP_PX || Math.abs(dy) > TAP_PX) return;
        if (hintShown) {
            dismissHint();
            return;
        }
        const ratio = e.nativeEvent.pageX / zoneW.current;
        if (ratio > CENTER_L && ratio < CENTER_R) {
            setChrome((v) => !v);
        } else if (settings.edgeTapTurn) {
            turnChapter(ratio <= CENTER_L ? -1 : 1);
        }
    };

    // ---------- 段落操作(RendererActions) ----------

    const onLongPressPara = useCallback((p: Para) => setMenuFloor(p.floor), []);
    const onLongPressFloor = useCallback((m: MessageViewModel) => setMenuFloor(m), []);
    const onSwipeBadge = useCallback((m: MessageViewModel) => setSwipeFloor(m), []);

    const menuActions: ParaAction[] = useMemo(() => {
        if (!menuFloor) return [];
        const list: ParaAction[] = [];
        if (menuFloor.role === 'assistant') {
            list.push({ key: 'regen', label: '重写此段', disabled: session.busy });
        }
        list.push({ key: 'edit', label: '编辑' });
        list.push({ key: 'branch', label: '从此分叉' });
        list.push({ key: 'copy', label: '复制' });
        return list;
    }, [menuFloor, session.busy]);

    const onMenuPick = useCallback((key: string) => {
        const floor = menuFloor;
        setMenuFloor(null);
        if (!floor) return;
        switch (key) {
            case 'regen':
                session.regenerate(floor.id);
                break;
            case 'edit':
                setEditFloor(floor);
                break;
            case 'branch': {
                setBusyNote('分叉中…');
                session.branch(floor.id)
                    .then((newName) => {
                        setBusyNote(null);
                        router.push({ pathname: '/book/[charDir]/[chatName]', params: { charDir: charDir!, chatName: newName, name: charName } });
                    })
                    .catch((e) => {
                        setBusyNote(null);
                        session.note(`分叉失败:${e instanceof Error ? e.message : String(e)}`);
                    });
                break;
            }
            case 'copy':
                session.copyFloor(floor.id);
                break;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [menuFloor, charDir, charName, session]);

    // ---------- 顶栏 ⋯ ----------

    const overflowActions: ParaAction[] = useMemo(() => [
        { key: 'mode', label: settings.mode === 'prose' ? '切到气泡形态' : '切到小说形态' },
        { key: 'card', label: '角色卡' },
        { key: 'panels', label: '状态面板' },
        { key: 'branchAll', label: '整卷分叉' },
        { key: 'export', label: '复制全文(导出)' },
        { key: 'book', label: '回到书页' },
    ], [settings.mode]);

    const onOverflowPick = useCallback((key: string) => {
        setOverflowOpen(false);
        switch (key) {
            case 'mode':
                store.patchSettings({ mode: settings.mode === 'prose' ? 'bubble' : 'prose' });
                break;
            case 'card':
                setCardOpen(true);
                break;
            case 'panels':
                // CardApp 面板页(TASK-009):带上会话身份,面板 tab 按参数
                // 定位;chatName 决定 th/call 的 chat 变量作用域。
                router.push({
                    pathname: '/panels',
                    params: { charDir: charDir!, chatName: chatName!, name: charName },
                });
                break;
            case 'branchAll': {
                setBusyNote('分叉中…');
                session.branch((session.messages ?? []).length - 1)
                    .then((newName) => {
                        setBusyNote(null);
                        router.push({ pathname: '/book/[charDir]/[chatName]', params: { charDir: charDir!, chatName: newName, name: charName } });
                    })
                    .catch((e) => {
                        setBusyNote(null);
                        session.note(`分叉失败:${e instanceof Error ? e.message : String(e)}`);
                    });
                break;
            }
            case 'export':
                Clipboard.setString(session.fullText());
                session.note('全文已复制');
                break;
            case 'book':
                router.back();
                break;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.mode, charDir, charName, session, store]);

    // 角色卡懒加载
    useEffect(() => {
        if (!cardOpen || card || cardLoading) return;
        setCardLoading(true);
        getCharacter(charDir!)
            .then(setCard)
            .finally(() => setCardLoading(false));
    }, [cardOpen, card, cardLoading, charDir]);

    // ---------- 书写层 ----------

    const onComposeSend = useCallback((text: string) => {
        setComposeOpen(false);
        session.send(text);
    }, [session]);

    // ---------- 渲染 ----------

    const progressRatio = paras.length > 1 ? viewPara / Math.max(1, paras.length - 1) : 0;
    const showFab = !chrome && !session.busy && session.messages != null;
    const themeBar = { backgroundColor: theme.chromeBg, borderColor: theme.line };

    const yourTurnFooter = (
        <View style={styles.footerZone}>
            {!session.busy ? (
                <Pressable style={[styles.yourTurn, { borderColor: theme.inkFaint }]} onPress={() => setComposeOpen(true)}>
                    <Text style={[styles.yourTurnText, { color: theme.inkFaint }]}>——轮到你落笔</Text>
                </Pressable>
            ) : (
                <Text style={[styles.inkHint, { color: theme.inkFaint }]}>墨迹接写中…</Text>
            )}
        </View>
    );

    return (
        <View style={[styles.root, { backgroundColor: theme.bg }]} onLayout={(e) => { zoneW.current = Math.max(1, e.nativeEvent.layout.width); }}>
            <Stack.Screen options={{ headerShown: false }} />
            <StatusBar style={theme.statusBar} />

            <View style={styles.fill} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                {session.messages === null ? (
                    <View style={styles.center}>
                        {session.loadErr
                            ? <Text style={[styles.errText, { color: theme.inkFaint }]}>{session.loadErr}</Text>
                            : <ActivityIndicator color={theme.sub} />}
                    </View>
                ) : settings.mode === 'prose' ? (
                    <ProseFlow
                        paras={paras}
                        chapters={chapters}
                        theme={theme}
                        settings={settings}
                        listRef={listRef}
                        initialIndex={restoreIndex}
                        streamingFloorId={liveFloor?.floorId}
                        onLongPressPara={onLongPressPara}
                        onSwipeBadge={onSwipeBadge}
                        onViewPara={setViewPara}
                        footer={yourTurnFooter}
                        frameCtx={{ charDir: charDir!, chatName: chatName! }}
                    />
                ) : (
                    <BubbleFlow
                        messages={[...(session.messages ?? []), ...(liveFloor ? [{
                            id: liveFloor.floorId, role: 'assistant' as const, name: liveFloor.name,
                            content: liveFloor.shown, streaming: true,
                        }] : [])]}
                        theme={theme}
                        settings={settings}
                        listRef={listRef}
                        streamingFloorId={liveFloor?.floorId}
                        userName={session.messages?.find((m) => m.role === 'user')?.name ?? '旅人'}
                        onLongPressFloor={onLongPressFloor}
                        onSwipeBadge={onSwipeBadge}
                        footer={yourTurnFooter}
                        frameCtx={{ charDir: charDir!, chatName: chatName! }}
                    />
                )}
            </View>

            {/* 亮度叠层(亮度=app 内遮罩近似;真实屏亮留给 expo-brightness) */}
            {settings.dim > 0 ? (
                <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: settings.dim }]} />
            ) : null}

            {/* hint 条(流式降级/操作回执) */}
            {session.hint ? (
                <Pressable style={[styles.hintBar, { top: insets.top + 6, backgroundColor: theme.cardBg, borderColor: theme.line }]} onPress={session.dismissHint}>
                    <Text style={[styles.hintText, { color: theme.sub }]}>{session.hint}</Text>
                </Pressable>
            ) : null}
            {busyNote ? (
                <View style={[styles.hintBar, { top: insets.top + 6, backgroundColor: theme.cardBg, borderColor: theme.line }]}>
                    <Text style={[styles.hintText, { color: theme.sub }]}>{busyNote}</Text>
                </View>
            ) : null}

            {/* 一次性 chrome 提示 */}
            {hintShown ? (
                <Pressable style={[styles.hintOverlay, { backgroundColor: 'rgba(0,0,0,0.45)' }]} onPress={dismissHint}>
                    <Text style={styles.hintOverlayText}>轻点屏幕中央{'\n'}呼出目录与工具</Text>
                </Pressable>
            ) : null}

            {/* chrome 层:<200ms 淡入 */}
            <Animated.View
                pointerEvents={chrome ? 'auto' : 'none'}
                style={[styles.chromeLayer, { opacity: chromeAnim }]}
            >
                <View style={[styles.topBar, themeBar, { paddingTop: insets.top + 4 }]}>
                    <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} hitSlop={10} style={styles.topBtn}>
                        <Text style={[styles.topGlyph, { color: theme.ink }]}>‹</Text>
                    </Pressable>
                    <View style={styles.topMid}>
                        <Text style={[styles.topTitle, { color: theme.ink }]} numberOfLines={1}>{chatName}</Text>
                        <Text style={[styles.topChapter, { color: theme.sub }]} numberOfLines={1}>
                            {curChapter ? `第 ${curChapterIdx + 1} 章 · ${curChapter.title}` : '正文'}
                        </Text>
                    </View>
                    <Pressable onPress={() => setOverflowOpen(true)} hitSlop={10} style={styles.topBtn}>
                        <Text style={[styles.topGlyph, { color: theme.ink }]}>⋯</Text>
                    </Pressable>
                </View>
                <View style={styles.chromeSpacer} />
                <View style={[styles.bottomBar, themeBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
                    <View style={styles.navRow}>
                        <Pressable onPress={() => turnChapter(-1)} disabled={curChapterIdx <= 0} style={styles.navBtn}>
                            <Text style={[styles.navText, { color: curChapterIdx <= 0 ? theme.inkFaint : theme.ink }]}>上一章</Text>
                        </Pressable>
                        <Pressable
                            style={styles.progressWrap}
                            onPress={(e) => {
                                const ratio = Math.min(1, Math.max(0, e.nativeEvent.locationX / Math.max(1, progressW.current)));
                                jumpTo(Math.round(ratio * Math.max(0, paras.length - 1)));
                            }}
                            onLayout={(e) => { progressW.current = e.nativeEvent.layout.width; }}
                        >
                            <View style={[styles.progressTrack, { backgroundColor: theme.line }]}>
                                <View style={[styles.progressFill, { backgroundColor: theme.accent, width: `${Math.min(100, Math.round(progressRatio * 100))}%` }]} />
                            </View>
                            <Text style={[styles.progressText, { color: theme.sub }]}>
                                {paras.length ? `${Math.round(progressRatio * 100)}%` : ''}
                            </Text>
                        </Pressable>
                        <Pressable onPress={() => turnChapter(1)} disabled={curChapterIdx >= chapters.length - 1} style={styles.navBtn}>
                            <Text style={[styles.navText, { color: curChapterIdx >= chapters.length - 1 ? theme.inkFaint : theme.ink }]}>下一章</Text>
                        </Pressable>
                    </View>
                    <View style={styles.toolRow}>
                        {([
                            ['目录', () => setDrawerOpen(true)],
                            [settings.mode === 'prose' ? '小说' : '气泡', () => store.patchSettings({ mode: settings.mode === 'prose' ? 'bubble' : 'prose' })],
                            ['Aa', () => setAaOpen(true)],
                            [settings.theme === 'night' ? '日间' : '夜间', () => store.toggleNight()],
                        ] as [string, () => void][]).map(([label, fn]) => (
                            <Pressable key={label} style={styles.toolBtn} onPress={fn}>
                                <Text style={[styles.toolText, { color: theme.ink }]}>{label}</Text>
                            </Pressable>
                        ))}
                    </View>
                </View>
            </Animated.View>

            {/* 书写层 FAB(沉浸态常驻;生成中收起) */}
            {showFab ? (
                <Pressable
                    style={[styles.fab, { bottom: insets.bottom + 26, backgroundColor: `${theme.accent}CC` }]}
                    onPress={() => setComposeOpen(true)}
                >
                    <Text style={styles.fabGlyph}>✎</Text>
                </Pressable>
            ) : null}

            {/* sheets */}
            <ChapterDrawer
                visible={drawerOpen}
                theme={theme}
                chapters={chapters}
                currentPara={viewPara}
                onJump={jumpTo}
                onClose={() => setDrawerOpen(false)}
            />
            <SwipeSheet
                visible={swipeFloor != null}
                floor={swipeFloor}
                theme={theme}
                onClose={() => setSwipeFloor(null)}
                onSelect={(id, i) => {
                    session.swipe(id, i);
                    setSwipeFloor(null);
                }}
                onRegenerate={(id) => {
                    setSwipeFloor(null);
                    session.regenerate(id);
                }}
            />
            <ParaMenu visible={menuFloor != null} theme={theme} actions={menuActions} onPick={onMenuPick} onClose={() => setMenuFloor(null)} />
            <ParaMenu visible={overflowOpen} theme={theme} actions={overflowActions} onPick={onOverflowPick} onClose={() => setOverflowOpen(false)} />
            <EditSheet
                visible={editFloor != null}
                theme={theme}
                /* content 槽是展示投影(GH#3)—— 编辑种子必须走 wire 原文,
                   否则投影文本会被写回 mes/swipes 污染存储。 */
                initial={editFloor ? session.rawFloorText(editFloor.id) : ''}
                busy={session.busy}
                onSave={(text) => {
                    const f = editFloor;
                    if (!f) return;
                    void session.submitEdit(f.id, text).then((ok) => {
                        if (ok) setEditFloor(null);
                    });
                }}
                onClose={() => setEditFloor(null)}
            />
            <ComposeSheet
                visible={composeOpen}
                theme={theme}
                busy={session.busy}
                onSend={onComposeSend}
                onClose={() => setComposeOpen(false)}
            />
            <AaPanel
                visible={aaOpen}
                theme={theme}
                settings={settings}
                onPatch={(p) => store.patchSettings(p)}
                onClose={() => setAaOpen(false)}
            />
            <CardSheet
                visible={cardOpen}
                theme={theme}
                card={card}
                avatarUri={conn.baseUrl ? `${conn.baseUrl}/characters/${encodeURIComponent(charDir!)}.png` : null}
                loading={cardLoading}
                onClose={() => setCardOpen(false)}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    fill: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    errText: { fontSize: 14, textAlign: 'center' },
    chromeLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'space-between' },
    chromeSpacer: { flex: 1 },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 6,
        paddingBottom: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    topBtn: { paddingHorizontal: 12, paddingVertical: 4 },
    topGlyph: { fontSize: 22, fontWeight: '600' },
    topMid: { flex: 1, alignItems: 'center' },
    topTitle: { fontSize: 14, fontWeight: '600' },
    topChapter: { fontSize: 11, marginTop: 1 },
    bottomBar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6 },
    navRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
    navBtn: { paddingVertical: 6 },
    navText: { fontSize: 13 },
    progressWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
    progressTrack: { flex: 1, height: 3, borderRadius: 2, overflow: 'hidden' },
    progressFill: { height: 3 },
    progressText: { fontSize: 11, width: 38, textAlign: 'right' },
    toolRow: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 2, paddingBottom: 4 },
    toolBtn: { paddingHorizontal: 18, paddingVertical: 6 },
    toolText: { fontSize: 13 },
    fab: {
        position: 'absolute',
        right: 22,
        width: 52,
        height: 52,
        borderRadius: 26,
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 4,
        shadowColor: '#000',
        shadowOpacity: 0.25,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 3 },
    },
    fabGlyph: { color: '#fff', fontSize: 22 },
    footerZone: { paddingVertical: 26, paddingHorizontal: 40 },
    yourTurn: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
    yourTurnText: { fontSize: 13, letterSpacing: 1 },
    inkHint: { textAlign: 'center', fontSize: 12, letterSpacing: 1 },
    hintBar: {
        position: 'absolute',
        alignSelf: 'center',
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 14,
        paddingVertical: 8,
        maxWidth: '86%',
    },
    hintText: { fontSize: 12 },
    hintOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
    hintOverlayText: { color: '#fff', fontSize: 16, lineHeight: 28, textAlign: 'center' },
});
