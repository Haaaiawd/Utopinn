// bubble 形态 —— 与 prose 共享同一组 floors/props 的备选渲染(conversation-
// renderers.md §2 seam 自证)。气泡 chrome:左右气泡 + 名字 + swipe 角标;
// 排版设置(字号)仍生效。消息列表即旧 chat 屏的呈现移植到阅读主题。
import { memo, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import type { MessageViewModel } from '@uberge/protocol';
import type { ReadingSettings } from '../state/reading';
import type { ReaderTheme } from './theme';

export interface BubbleFlowProps {
    messages: MessageViewModel[];
    theme: ReaderTheme;
    settings: ReadingSettings;
    listRef: React.RefObject<LegendListRef | null>;
    streamingFloorId?: number | null;
    userName: string;
    onLongPressFloor: (floor: MessageViewModel) => void;
    onSwipeBadge: (floor: MessageViewModel) => void;
    footer?: ReactElement;
}

function fmtTs(ts?: string | number): string {
    if (ts == null) return '';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const Bubble = memo(function Bubble({ m, theme, settings, streaming, userName, onLongPressFloor, onSwipeBadge }: {
    m: MessageViewModel;
    theme: ReaderTheme;
    settings: ReadingSettings;
    streaming: boolean;
    userName: string;
    onLongPressFloor: (f: MessageViewModel) => void;
    onSwipeBadge: (f: MessageViewModel) => void;
}) {
    if (m.role === 'system') {
        return m.content ? <Text style={[styles.sys, { color: theme.inkFaint }]}>{m.content}</Text> : null;
    }
    const isUser = m.role === 'user';
    const swipes = m.swipes ?? [];
    const active = m.activeSwipe ?? 0;
    const fontSize = Math.max(13, settings.fontSize - 3);
    return (
        <Pressable onLongPress={() => onLongPressFloor(m)} delayLongPress={420}>
            <View style={[styles.row, isUser && styles.rowUser]}>
                <View style={[
                    styles.bubble,
                    { borderColor: theme.line },
                    isUser ? { backgroundColor: `${theme.accent}33` } : { backgroundColor: theme.cardBg },
                ]}>
                    <Text style={[styles.name, { color: theme.sub }]}>{m.name || (isUser ? userName : '?')}</Text>
                    <Text style={[styles.text, { color: theme.ink, fontSize, lineHeight: Math.round(fontSize * 1.5) }]}>
                        {m.displayContent ?? m.content}
                        {streaming ? ' ▍' : ''}
                    </Text>
                    <View style={styles.metaRow}>
                        {swipes.length > 1 ? (
                            <Text style={[styles.swipe, { color: theme.accent }]} onPress={() => onSwipeBadge(m)}>
                                ✦{active + 1}/{swipes.length}稿
                            </Text>
                        ) : <View />}
                        <Text style={[styles.time, { color: theme.inkFaint }]}>{fmtTs(m.timestamp)}</Text>
                    </View>
                </View>
            </View>
        </Pressable>
    );
});

export function BubbleFlow({ messages, theme, settings, listRef, streamingFloorId, userName, onLongPressFloor, onSwipeBadge, footer }: BubbleFlowProps) {
    return (
        <LegendList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => String(m.id)}
            renderItem={({ item }) => (
                <Bubble
                    m={item}
                    theme={theme}
                    settings={settings}
                    streaming={streamingFloorId === item.id}
                    userName={userName}
                    onLongPressFloor={onLongPressFloor}
                    onSwipeBadge={onSwipeBadge}
                />
            )}
            estimatedItemSize={72}
            maintainScrollAtEnd
            alignItemsAtEnd
            contentContainerStyle={styles.content}
            ListFooterComponent={footer}
            recycleItems
        />
    );
}

const styles = StyleSheet.create({
    content: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 60, flexGrow: 1 },
    sys: { fontSize: 11, textAlign: 'center', marginVertical: 8, paddingHorizontal: 24 },
    row: { flexDirection: 'row', marginVertical: 4 },
    rowUser: { justifyContent: 'flex-end' },
    bubble: { maxWidth: '82%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9, borderWidth: StyleSheet.hairlineWidth },
    name: { fontSize: 11, marginBottom: 3 },
    text: {},
    metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, gap: 8 },
    swipe: { fontSize: 10, fontWeight: '600' },
    time: { fontSize: 10 },
});
