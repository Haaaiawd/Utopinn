// 对话 — 全部角色 × 全部会话的聚合列表(按 updatedAt 倒序),点进 → 聊天屏。
// N+1 查询由 listAllChats 内部 Promise.all 打平;单角色失败跳过不炸全表。
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { avatarUrl, listAllChats, type ChatSummary } from '../../src/api/client';
import { colors } from '../../src/ui/theme';

function fmtTime(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function Row({ item }: { item: ChatSummary }) {
    const uri = avatarUrl(item.avatar);
    return (
        <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() =>
                router.push({
                    pathname: '/chat/[charDir]/[chatName]',
                    params: { charDir: item.charDir, chatName: item.chatName, name: item.charName },
                })
            }
        >
            {uri ? (
                <Image source={{ uri }} style={styles.avatar} />
            ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarInitial}>{(item.charName || item.charDir).slice(0, 1)}</Text>
                </View>
            )}
            <View style={styles.rowBody}>
                <View style={styles.rowTop}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{item.charName}</Text>
                    <Text style={styles.rowTime}>{fmtTime(item.updatedAt)}</Text>
                </View>
                <Text style={styles.rowSub} numberOfLines={1}>
                    {item.chatName} · {item.messageCount} 楼
                </Text>
            </View>
        </Pressable>
    );
}

export default function ChatsTab() {
    const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
        queryKey: ['all-chats'],
        queryFn: listAllChats,
    });

    return (
        <View style={styles.root}>
            <FlatList
                data={data ?? []}
                keyExtractor={(c) => c.id}
                refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.sub} />}
                contentContainerStyle={data?.length ? undefined : styles.emptyGrow}
                renderItem={({ item }) => <Row item={item} />}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        {isLoading ? (
                            <Text style={styles.emptyText}>加载中…</Text>
                        ) : isError ? (
                            <>
                                <Text style={styles.emptyText}>连不上服务器</Text>
                                <Text style={styles.emptySub}>{error instanceof Error ? error.message : '请检查「我的」里的连接设置'}</Text>
                            </>
                        ) : (
                            <>
                                <Text style={styles.emptyText}>还没有会话</Text>
                                <Text style={styles.emptySub}>去「角色」挑一张卡开始聊</Text>
                            </>
                        )}
                    </View>
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
    },
    rowPressed: { backgroundColor: colors.card },
    avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.cardAlt },
    avatarFallback: { backgroundColor: colors.accentDim, alignItems: 'center', justifyContent: 'center' },
    avatarInitial: { color: colors.text, fontSize: 20, fontWeight: '700' },
    rowBody: { flex: 1 },
    rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    rowTitle: { color: colors.text, fontSize: 16, fontWeight: '600', flex: 1 },
    rowTime: { color: colors.dim, fontSize: 11 },
    rowSub: { color: colors.sub, fontSize: 13, marginTop: 3 },
    emptyGrow: { flexGrow: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyText: { color: colors.sub, fontSize: 15 },
    emptySub: { color: colors.dim, fontSize: 12, marginTop: 8, textAlign: 'center' },
});
