// prose 渲染器的 RN 实例 —— design §2 正文映射(方案A)+ §3 排版规格:
//  段首缩进 2 字 | *动作* 斜体弱墨 | [*内心*] 更弱 | "对话" 引号高亮
//  user 段左缘发丝线 | 生成中墨点呼吸 + 逐字淡入 | swipe ✦N稿 角标
//  长按段 = 操作菜单 | reasoning=作者草稿折叠块 | receipts=作者有话说
// 渲染器只画 + 报手势;swipe/edit/章节语义全是宿主的。
import { memo, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import type { MessageReceipt, MessageViewModel } from '@utopinn/protocol';
import type { ReadingSettings } from '../state/reading';
import { inlineSegs, PARA_INDENT, type Chapter, type InlineSeg, type Para } from './format';
import { readerFontFamily, type ReaderTheme } from './theme';

export interface ProseFlowProps {
    paras: Para[];
    chapters: Chapter[];
    theme: ReaderTheme;
    settings: ReadingSettings;
    listRef: React.RefObject<LegendListRef | null>;
    /** 恢复进度:首渲染落到的段下标(undefined=自然停在文首/文末)。 */
    initialIndex?: number;
    /** 生成中的楼层 id(墨点呼吸锚点)。 */
    streamingFloorId?: number | null;
    onLongPressPara: (para: Para) => void;
    onSwipeBadge: (floor: MessageViewModel) => void;
    /** 视口首段下标变化 → 宿主更新进度/当前章。 */
    onViewPara: (index: number) => void;
    /** 末尾「——轮到你落笔」占位。 */
    footer?: ReactElement;
}

// ---------- inline 渲染 ----------

function Segs({ text, theme, settings, base }: { text: string; theme: ReaderTheme; settings: ReadingSettings; base: object }) {
    const segs = inlineSegs(text);
    return (
        <>
            {segs.map((s: InlineSeg, i: number) => {
                switch (s.type) {
                    case 'action':
                        return <Text key={i} style={[base, { fontStyle: 'italic', color: theme.inkSoft }]}>{s.text}</Text>;
                    case 'thought':
                        return <Text key={i} style={[base, { fontStyle: 'italic', color: theme.inkFaint }]}>({s.text})</Text>;
                    case 'quote':
                        return <Text key={i} style={[base, settings.quoteHighlight && { color: theme.quote }]}>{s.text}</Text>;
                    case 'bold':
                        return <Text key={i} style={[base, { fontWeight: '700' }]}>{s.text}</Text>;
                    default:
                        return <Text key={i} style={base}>{s.text}</Text>;
                }
            })}
        </>
    );
}

// ---------- 生成中墨点(段前 6px 呼吸) ----------

function InkDot({ theme }: { theme: ReaderTheme }) {
    const op = useRef(new Animated.Value(0.25)).current;
    useEffect(() => {
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(op, { toValue: 1, duration: 600, useNativeDriver: true }),
                Animated.timing(op, { toValue: 0.25, duration: 600, useNativeDriver: true }),
            ]),
        );
        loop.start();
        return () => loop.stop();
    }, [op]);
    return <Animated.View style={[styles.inkDot, { backgroundColor: theme.ink, opacity: op }]} />;
}

// ---------- receipts「作者有话说」/ reasoning「作者草稿」 ----------

function Receipts({ receipts, theme }: { receipts: MessageReceipt[]; theme: ReaderTheme }) {
    const [open, setOpen] = useState(false);
    if (!receipts.length) return null;
    return (
        <View style={[styles.receipt, { borderColor: theme.line, backgroundColor: `${theme.accent}14` }]}>
            <Pressable onPress={() => setOpen((v) => !v)} style={styles.receiptHead}>
                <Text style={[styles.receiptTitle, { color: theme.accent }]}>作者有话说</Text>
                <Text style={[styles.receiptToggle, { color: theme.inkFaint }]}>{open ? '收起' : `${receipts.length} 条`}</Text>
            </Pressable>
            {open ? receipts.map((r, i) => (
                <Text key={i} style={[styles.receiptBody, { color: theme.inkSoft }]}>
                    {r.summary ?? r.kind}
                    {(r.ops?.length ?? 0) > 0 ? `\n${r.ops!.map((o) => `${o.op} ${o.key}${o.path ? `.${o.path}` : ''} → ${JSON.stringify(o.value)}`).join('\n')}` : ''}
                </Text>
            )) : null}
        </View>
    );
}

function Reasoning({ text, theme }: { text: string; theme: ReaderTheme }) {
    const [open, setOpen] = useState(false);
    return (
        <View style={[styles.reasoning, { borderLeftColor: theme.line }]}>
            <Pressable onPress={() => setOpen((v) => !v)}>
                <Text style={[styles.reasoningTitle, { color: theme.inkFaint }]}>作者草稿 · {open ? '收起' : '展开'}</Text>
            </Pressable>
            {open ? <Text style={[styles.reasoningBody, { color: theme.inkFaint }]}>{text}</Text> : null}
        </View>
    );
}

// ---------- 段落行 ----------

interface RowProps {
    para: Para;
    theme: ReaderTheme;
    settings: ReadingSettings;
    chapterTitle?: string;
    streaming: boolean;
    onLongPressPara: (para: Para) => void;
    onSwipeBadge: (floor: MessageViewModel) => void;
}

const ParaRow = memo(function ParaRow({ para, theme, settings, chapterTitle, streaming, onLongPressPara, onSwipeBadge }: RowProps) {
    const [hiddenOpen, setHiddenOpen] = useState(false);
    const m = para.floor;
    const body = {
        fontSize: settings.fontSize,
        lineHeight: Math.round(settings.fontSize * settings.lineHeight),
        fontFamily: readerFontFamily(settings.fontKey),
        color: theme.ink,
    };
    const swipes = m.swipes ?? [];
    const active = m.activeSwipe ?? 0;

    // hidden/system → 幕间灰字小注(hidden 可折叠)
    if (m.role === 'system') {
        return (
            <View>
                {chapterTitle ? <ChapterHead title={chapterTitle} theme={theme} /> : null}
                {para.text ? <Text style={[styles.systemNote, { color: theme.inkFaint, fontSize: settings.fontSize * 0.72 }]}>{para.text}</Text> : null}
            </View>
        );
    }
    if (m.hidden) {
        return (
            <View>
                {chapterTitle ? <ChapterHead title={chapterTitle} theme={theme} /> : null}
                <Pressable onLongPress={() => onLongPressPara(para)} onPress={() => setHiddenOpen((v) => !v)}>
                    <Text style={[styles.systemNote, { color: theme.inkFaint, fontSize: settings.fontSize * 0.72 }]}>
                        幕间 · {hiddenOpen ? para.text : `${para.text.slice(0, 24)}${para.text.length > 24 ? '…' : ''}(展开)`}
                    </Text>
                </Pressable>
            </View>
        );
    }

    const isUser = m.role === 'user';
    const interrupted = !!m.interrupted;
    const paraText = (
        <Pressable onLongPress={() => onLongPressPara(para)} delayLongPress={420}>
            <Text style={[styles.para, body, interrupted && { opacity: 0.5 }]}>
                <Text>{PARA_INDENT}</Text>
                <Segs text={para.text} theme={theme} settings={settings} base={body} />
                {para.isFloorLast && swipes.length > 1 ? (
                    <Text
                        style={[styles.swipeBadge, { color: theme.accent, fontSize: settings.fontSize * 0.72 }]}
                        onPress={() => onSwipeBadge(m)}
                    >
                        {`  ✦${swipes.length}稿·${active + 1}`}
                    </Text>
                ) : null}
                {streaming ? <Text style={{ color: theme.accent }}> ▍</Text> : null}
            </Text>
        </Pressable>
    );

    return (
        <View style={styles.paraWrap}>
            {chapterTitle ? <ChapterHead title={chapterTitle} theme={theme} /> : null}
            {para.isFloorFirst && streaming ? (
                <View style={styles.inkDotAnchor}><InkDot theme={theme} /></View>
            ) : null}
            {isUser && settings.userMark ? (
                <View style={[styles.userBlock, { borderLeftColor: `${theme.accent}59` }]}>
                    {m.reasoning && para.isFloorFirst ? <Reasoning text={m.reasoning} theme={theme} /> : null}
                    {paraText}
                </View>
            ) : (
                <View>
                    {m.reasoning && para.isFloorFirst ? <Reasoning text={m.reasoning} theme={theme} /> : null}
                    {paraText}
                </View>
            )}
            {interrupted && para.isFloorLast ? (
                <View style={styles.interruptedWrap}>
                    <View style={[styles.dashed, { borderBottomColor: theme.inkFaint }]} />
                    <Text style={[styles.interruptedText, { color: theme.inkFaint }]}>残稿 · 已中断</Text>
                </View>
            ) : null}
            {para.isFloorLast && m.receipts?.length ? <Receipts receipts={m.receipts} theme={theme} /> : null}
        </View>
    );
});

function ChapterHead({ title, theme }: { title: string; theme: ReaderTheme }) {
    return (
        <View style={styles.chapterHead}>
            <View style={[styles.chapterRule, { backgroundColor: theme.line }]} />
            <Text style={[styles.chapterTitle, { color: theme.sub }]} numberOfLines={1}>{title}</Text>
            <View style={[styles.chapterRule, { backgroundColor: theme.line }]} />
        </View>
    );
}

// ---------- 列表 ----------

export function ProseFlow({
    paras,
    chapters,
    theme,
    settings,
    listRef,
    initialIndex,
    streamingFloorId,
    onLongPressPara,
    onSwipeBadge,
    onViewPara,
    footer,
}: ProseFlowProps) {
    const chapterHeads = new Map<number, string>();
    if (settings.chapterTitleInPage) {
        for (const c of chapters) chapterHeads.set(c.paraStart, c.title);
    }
    return (
        <LegendList
            ref={listRef}
            data={paras}
            keyExtractor={(p) => p.key}
            renderItem={({ item }) => (
                <ParaRow
                    para={item}
                    theme={theme}
                    settings={settings}
                    chapterTitle={chapterHeads.get(item.index)}
                    streaming={streamingFloorId != null && item.floorId === streamingFloorId}
                    onLongPressPara={onLongPressPara}
                    onSwipeBadge={onSwipeBadge}
                />
            )}
            estimatedItemSize={40}
            initialScrollIndex={initialIndex}
            maintainScrollAtEnd
            alignItemsAtEnd
            onViewableItemsChanged={({ viewableItems }) => {
                const first = viewableItems.find((v) => v.item != null);
                if (first?.index != null) onViewPara(first.index);
            }}
            contentContainerStyle={styles.content}
            ListFooterComponent={footer}
            recycleItems
        />
    );
}

const styles = StyleSheet.create({
    content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 60, flexGrow: 1 },
    paraWrap: {},
    inkDotAnchor: { position: 'absolute', left: -14, top: 11 },
    inkDot: { width: 6, height: 6, borderRadius: 3 },
    userBlock: { flex: 1, borderLeftWidth: 2, paddingLeft: 12, marginVertical: 6 },
    para: { marginBottom: 8 },
    swipeBadge: { fontWeight: '600' },
    systemNote: { textAlign: 'center', marginVertical: 10, paddingHorizontal: 28, lineHeight: 20 },
    chapterHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 26, marginBottom: 12 },
    chapterRule: { flex: 1, height: StyleSheet.hairlineWidth },
    chapterTitle: { fontSize: 13, letterSpacing: 2, maxWidth: '72%' },
    reasoning: { borderLeftWidth: 2, paddingLeft: 10, marginBottom: 6 },
    reasoningTitle: { fontSize: 11, letterSpacing: 1 },
    reasoningBody: { fontSize: 12, lineHeight: 18, marginTop: 4, fontStyle: 'italic' },
    receipt: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10, marginBottom: 10, marginTop: 2 },
    receiptHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    receiptTitle: { fontSize: 12, fontWeight: '600' },
    receiptToggle: { fontSize: 11 },
    receiptBody: { fontSize: 12, lineHeight: 18, marginTop: 6 },
    interruptedWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    dashed: { flex: 1, borderBottomWidth: 1, borderStyle: 'dashed' },
    interruptedText: { fontSize: 11 },
});
