// 角色 — GET /api/uberge/characters 列表,点进 → 该角色的会话列表。
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { avatarUrl, listCharacters, type CharacterItem } from '../../src/api/client';
import { colors } from '../../src/ui/theme';

function Avatar({ item, size }: { item: CharacterItem; size: number }) {
    const uri = avatarUrl(item.avatar);
    if (uri) {
        return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.cardAlt }} />;
    }
    return (
        <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
            <Text style={styles.avatarInitial}>{(item.name || item.charDir).slice(0, 1)}</Text>
        </View>
    );
}

export default function CharactersScreen() {
    const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
        queryKey: ['characters'],
        queryFn: listCharacters,
    });

    return (
        <View style={styles.root}>
            <FlatList
                data={data ?? []}
                keyExtractor={(c) => c.charDir}
                refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.sub} />}
                contentContainerStyle={data?.length ? undefined : styles.emptyGrow}
                renderItem={({ item }) => (
                    <Pressable
                        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                        onPress={() => router.push({ pathname: '/chats/[charDir]', params: { charDir: item.charDir, name: item.name } })}
                    >
                        <Avatar item={item} size={52} />
                        <View style={styles.rowBody}>
                            <Text style={styles.rowTitle} numberOfLines={1}>{item.name || item.charDir}</Text>
                            <Text style={styles.rowSub} numberOfLines={1}>{item.charDir}</Text>
                        </View>
                        <Text style={styles.chev}>›</Text>
                    </Pressable>
                )}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        {isLoading ? (
                            <Text style={styles.emptyText}>加载中…</Text>
                        ) : isError ? (
                            <>
                                <Text style={styles.emptyText}>连不上服务器</Text>
                                <Text style={styles.emptySub}>{error instanceof Error ? error.message : '请检查「我的」里的连接设置'}</Text>
                                <Pressable style={styles.retry} onPress={() => void refetch()}>
                                    <Text style={styles.retryText}>重试</Text>
                                </Pressable>
                            </>
                        ) : (
                            <Text style={styles.emptyText}>还没有角色卡</Text>
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
    rowBody: { flex: 1 },
    rowTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
    rowSub: { color: colors.dim, fontSize: 12, marginTop: 3 },
    chev: { color: colors.dim, fontSize: 22 },
    avatarFallback: { backgroundColor: colors.accentDim, alignItems: 'center', justifyContent: 'center' },
    avatarInitial: { color: colors.text, fontSize: 22, fontWeight: '700' },
    emptyGrow: { flexGrow: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyText: { color: colors.sub, fontSize: 15 },
    emptySub: { color: colors.dim, fontSize: 12, marginTop: 8, textAlign: 'center' },
    retry: { marginTop: 16, backgroundColor: colors.cardAlt, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 9, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    retryText: { color: colors.text, fontSize: 14 },
});
