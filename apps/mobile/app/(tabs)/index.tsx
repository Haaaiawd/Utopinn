// 书架 — 会话聚合=书(design §1):单行列表,行=3:4 竖版封面(角色图)
//   + 书名(chatName) + 副行(最新段落首句截断) + 徽标(进行中/N 段未读)。
// 智能筛选:进行中 / 有更新 / 按角色。数据走现有 api-client 会话列表。
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { FlatList, Image, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { avatarUrl, listAllChats, type ChatSummary } from '../../src/api/client';
import { previewLine } from '../../src/reader/format';
import { useProgressMap, type ReadProgress } from '../../src/state/reading';
import { colors } from '../../src/ui/theme';

type Filter = 'all' | 'reading' | 'updated' | 'byChar';

const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'reading', label: '进行中' },
    { key: 'updated', label: '有更新' },
    { key: 'byChar', label: '按角色' },
];

function fmtTime(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 徽标:「N 段未读」>「进行中」> 无。 */
function badge(item: ChatSummary, p: ReadProgress | null): { text: string; hot: boolean } | null {
    if (!p) return null;
    const unread = Math.max(0, item.messageCount - p.floors);
    if (unread > 0) return { text: `${unread} 段未读`, hot: true };
    return { text: '进行中', hot: false };
}

function Row({ item, progress }: { item: ChatSummary; progress: ReadProgress | null }) {
    const uri = avatarUrl(item.avatar);
    const b = badge(item, progress);
    return (
        <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() =>
                router.push({
                    pathname: '/book/[charDir]/[chatName]',
                    params: { charDir: item.charDir, chatName: item.chatName, name: item.charName },
                })
            }
        >
            {uri ? (
                <Image source={{ uri }} style={styles.cover} />
            ) : (
                <View style={[styles.cover, styles.coverFallback]}>
                    <Text style={styles.coverInitial}>{(item.charName || item.charDir).slice(0, 1)}</Text>
                </View>
            )}
            <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.chatName}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                    {previewLine(item.lastMessage, 40) || `${item.charName} · ${item.messageCount} 段`}
                </Text>
                <View style={styles.rowMeta}>
                    <Text style={styles.rowChar} numberOfLines={1}>{item.charName}</Text>
                    <Text style={styles.rowTime}>{fmtTime(item.updatedAt)}</Text>
                </View>
            </View>
            {b ? (
                <View style={[styles.badge, b.hot ? styles.badgeHot : styles.badgeCalm]}>
                    <Text style={[styles.badgeText, b.hot ? styles.badgeTextHot : styles.badgeTextCalm]}>{b.text}</Text>
                </View>
            ) : null}
        </Pressable>
    );
}

export default function ShelfScreen() {
    const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
        queryKey: ['all-chats'],
        queryFn: listAllChats,
    });
    if (isError) console.warn('[dbg] all-chats error:', error instanceof Error ? (error.stack ?? error.message) : error);
    const [filter, setFilter] = useState<Filter>('all');
    const progressMap = useProgressMap();

    const filtered = useMemo(() => {
        const items = data ?? [];
        switch (filter) {
            case 'reading':
                return items.filter((c) => progressMap[c.id] != null);
            case 'updated':
                return items.filter((c) => {
                    const p = progressMap[c.id];
                    return p != null && c.messageCount - p.floors > 0;
                });
            default:
                return items;
        }
    }, [data, filter, progressMap]);

    const sections = useMemo(() => {
        if (filter !== 'byChar') return [];
        const map = new Map<string, ChatSummary[]>();
        for (const c of filtered) {
            const list = map.get(c.charName) ?? [];
            list.push(c);
            map.set(c.charName, list);
        }
        return [...map.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([title, items]) => ({ title, data: items }));
    }, [filtered, filter]);

    const empty = (
        <View style={styles.empty}>
            {isLoading ? (
                <Text style={styles.emptyText}>上架中…</Text>
            ) : isError ? (
                <>
                    <Text style={styles.emptyText}>连不上服务器</Text>
                    <Text style={styles.emptySub}>{error instanceof Error ? error.message : '请检查「我的」里的连接设置'}</Text>
                </>
            ) : filter !== 'all' ? (
                <Text style={styles.emptyText}>这个筛法下没有书</Text>
            ) : (
                <>
                    <Text style={styles.emptyText}>书架是空的</Text>
                    <Text style={styles.emptySub}>去「角色」挑一张卡,开一本书</Text>
                </>
            )}
        </View>
    );

    return (
        <View style={styles.root}>
            <View style={styles.chips}>
                {FILTERS.map((f) => {
                    const on = filter === f.key;
                    return (
                        <Pressable
                            key={f.key}
                            style={[styles.chip, on && styles.chipOn]}
                            onPress={() => setFilter(f.key)}
                        >
                            <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.label}</Text>
                        </Pressable>
                    );
                })}
            </View>
            {filter === 'byChar' ? (
                <SectionList
                    sections={sections}
                    keyExtractor={(c) => c.id}
                    renderItem={({ item }) => <Row item={item} progress={progressMap[item.id] ?? null} />}
                    renderSectionHeader={({ section }) => <Text style={styles.sectionHead}>{section.title}</Text>}
                    refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.sub} />}
                    contentContainerStyle={sections.length ? undefined : styles.emptyGrow}
                    ListEmptyComponent={empty}
                    stickySectionHeadersEnabled={false}
                />
            ) : (
                <FlatList
                    data={filtered}
                    keyExtractor={(c) => c.id}
                    renderItem={({ item }) => <Row item={item} progress={progressMap[item.id] ?? null} />}
                    refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.sub} />}
                    contentContainerStyle={filtered.length ? undefined : styles.emptyGrow}
                    ListEmptyComponent={empty}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
    chip: {
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        backgroundColor: colors.card,
        paddingHorizontal: 12,
        paddingVertical: 5,
    },
    chipOn: { backgroundColor: colors.accentDim, borderColor: colors.accent },
    chipText: { color: colors.sub, fontSize: 12 },
    chipTextOn: { color: colors.text, fontWeight: '600' },
    sectionHead: { color: colors.dim, fontSize: 12, letterSpacing: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
    row: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 11,
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
    },
    rowPressed: { backgroundColor: colors.card },
    cover: { width: 51, height: 68, borderRadius: 4, backgroundColor: colors.cardAlt },
    coverFallback: { backgroundColor: colors.accentDim, alignItems: 'center', justifyContent: 'center' },
    coverInitial: { color: colors.text, fontSize: 20, fontWeight: '700' },
    rowBody: { flex: 1, justifyContent: 'center' },
    rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    rowSub: { color: colors.sub, fontSize: 12, marginTop: 4 },
    rowMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 },
    rowChar: { color: colors.dim, fontSize: 11, flexShrink: 1 },
    rowTime: { color: colors.dim, fontSize: 10 },
    badge: { alignSelf: 'center', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 3 },
    badgeHot: { backgroundColor: colors.accentDim },
    badgeCalm: { backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    badgeText: { fontSize: 10, fontWeight: '600' },
    badgeTextHot: { color: colors.text },
    badgeTextCalm: { color: colors.sub },
    emptyGrow: { flexGrow: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyText: { color: colors.sub, fontSize: 15 },
    emptySub: { color: colors.dim, fontSize: 12, marginTop: 8, textAlign: 'center' },
});
