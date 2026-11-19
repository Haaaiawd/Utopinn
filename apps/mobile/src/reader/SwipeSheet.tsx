// 「✦N稿」半屏候选卡 —— design §2:swipe → 段尾角标 → 半屏候选卡
// (60 字预览 + 时间戳,选定稿走 actions.swipe —— 渲染器只调宿主回调)。
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MessageViewModel } from '@utopinn/protocol';
import { previewLine } from './format';
import { Sheet } from './Sheet';
import type { ReaderTheme } from './theme';

function fmtTs(ts?: string | number): string {
    if (ts == null) return '';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface SwipeSheetProps {
    visible: boolean;
    floor: MessageViewModel | null;
    theme: ReaderTheme;
    onClose: () => void;
    onSelect: (floorId: number, index: number) => void;
    /** 「再写一稿」—— 由宿主接 regen 管线(通常是末楼层才可)。 */
    onRegenerate?: (floorId: number) => void;
}

export function SwipeSheet({ visible, floor, theme, onClose, onSelect, onRegenerate }: SwipeSheetProps) {
    const swipes = floor?.swipes ?? [];
    const active = floor?.activeSwipe ?? 0;
    return (
        <Sheet visible={visible} onClose={onClose} theme={theme} title={`候选稿 · 第 ${active + 1} / ${swipes.length} 稿`} ratio={0.6}>
            <FlatList
                data={swipes}
                keyExtractor={(s) => String(s.index)}
                style={styles.list}
                renderItem={({ item }) => {
                    const selected = item.index === active;
                    return (
                        <Pressable
                            style={[styles.row, { borderColor: selected ? theme.accent : theme.line, backgroundColor: theme.bg }]}
                            onPress={() => floor && onSelect(floor.id, item.index)}
                        >
                            <View style={styles.rowHead}>
                                <Text style={[styles.rowIndex, { color: selected ? theme.accent : theme.sub }]}>
                                    稿 {item.index + 1}
                                </Text>
                                <Text style={[styles.rowTs, { color: theme.inkFaint }]}>{fmtTs(item.timestamp)}</Text>
                                {selected ? <Text style={[styles.rowMark, { color: theme.accent }]}>当前</Text> : null}
                            </View>
                            <Text style={[styles.rowText, { color: theme.ink }]} numberOfLines={3}>
                                {previewLine(item.content, 90)}
                            </Text>
                        </Pressable>
                    );
                }}
                ListFooterComponent={
                    floor && onRegenerate ? (
                        <Pressable style={[styles.regen, { borderColor: theme.line }]} onPress={() => onRegenerate(floor.id)}>
                            <Text style={[styles.regenText, { color: theme.accent }]}>↻ 再写一稿</Text>
                        </Pressable>
                    ) : undefined
                }
            />
        </Sheet>
    );
}

const styles = StyleSheet.create({
    list: { paddingHorizontal: 16 },
    row: { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 },
    rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 },
    rowIndex: { fontSize: 12, fontWeight: '700' },
    rowTs: { fontSize: 11, flex: 1 },
    rowMark: { fontSize: 11, fontWeight: '600' },
    rowText: { fontSize: 13, lineHeight: 19 },
    regen: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, borderStyle: 'dashed', paddingVertical: 12, alignItems: 'center', marginBottom: 8 },
    regenText: { fontSize: 14, fontWeight: '600' },
});
