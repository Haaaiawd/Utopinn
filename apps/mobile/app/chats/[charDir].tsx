// 角色的「作品列表」— 该角色下全部会话=同一个角色的几本书;
// 点进 → 书页;无会话自动建一本 `Mobile <MMDD-HHmm>`;「+ 新会话」永远可用。
import { useEffect, useRef, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { avatarUrl, createChat, listChats, type ChatItem } from '../../src/api/client';
import { previewLine } from '../../src/reader/format';
import { colors } from '../../src/ui/theme';

function newChatName(): string {
    const d = new Date();
    const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const hm = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    return `Mobile ${mmdd}-${hm}`;
}

export default function CharacterChatsScreen() {
    const { charDir, name } = useLocalSearchParams<{ charDir: string; name?: string }>();
    const queryClient = useQueryClient();
    const [creating, setCreating] = useState(false);
    const [createErr, setCreateErr] = useState<string | null>(null);
    const autoCreated = useRef(false);

    const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
        queryKey: ['chats', charDir],
        queryFn: () => listChats(charDir!),
        enabled: !!charDir,
    });

    const openBook = (chatName: string, mode: 'push' | 'replace' = 'push') => {
        router[mode]({
            pathname: '/book/[charDir]/[chatName]',
            params: { charDir: charDir!, chatName, name: name ?? charDir! },
        });
    };

    const createAndOpen = async (mode: 'push' | 'replace' = 'push') => {
        if (creating || !charDir) return;
        setCreating(true);
        setCreateErr(null);
        try {
            const chatName = newChatName();
            await createChat(charDir, chatName);
            await queryClient.invalidateQueries({ queryKey: ['chats', charDir] });
            openBook(chatName, mode);
        } catch (e) {
            setCreateErr(e instanceof Error ? e.message : String(e));
        } finally {
            setCreating(false);
        }
    };

    // 无会话 → 自动建一本再进书页(replace:返回键回角色列表,不落在空列表上)
    useEffect(() => {
        if (autoCreated.current || isLoading || isError || !data || data.length > 0 || creating) return;
        autoCreated.current = true;
        void createAndOpen('replace');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, isLoading, isError]);

    const coverUri = avatarUrl(`${charDir}.png`);

    return (
        <View style={styles.root}>
            <Stack.Screen options={{ title: name || charDir || '作品' }} />
            <Pressable style={({ pressed }) => [styles.newBtn, pressed && { opacity: 0.8 }]} onPress={() => void createAndOpen()} disabled={creating}>
                <Text style={styles.newBtnText}>{creating ? '创建中…' : '+ 新会话'}</Text>
            </Pressable>
            {createErr ? <Text style={styles.err}>{createErr}</Text> : null}
            <FlatList
                data={data ?? []}
                keyExtractor={(c) => c.name}
                refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.sub} />}
                contentContainerStyle={data?.length ? undefined : styles.emptyGrow}
                renderItem={({ item }: { item: ChatItem }) => (
                    <Pressable
                        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                        onPress={() => openBook(item.name)}
                    >
                        {coverUri ? (
                            <Image source={{ uri: coverUri }} style={styles.cover} />
                        ) : (
                            <View style={[styles.cover, styles.coverFallback]}>
                                <Text style={styles.coverInitial}>{(name || charDir || '?').slice(0, 1)}</Text>
                            </View>
                        )}
                        <View style={styles.rowBody}>
                            <Text style={styles.rowTitle} numberOfLines={1}>{item.name}</Text>
                            <Text style={styles.rowSub} numberOfLines={1}>
                                {item.messageCount ?? 0} 段{item.lastMessage ? ` · ${previewLine(item.lastMessage, 30)}` : ''}
                            </Text>
                        </View>
                        <Text style={styles.chev}>›</Text>
                    </Pressable>
                )}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        {isLoading || creating ? (
                            <Text style={styles.emptyText}>{creating ? '正在创建会话…' : '加载中…'}</Text>
                        ) : isError ? (
                            <>
                                <Text style={styles.emptyText}>连不上服务器</Text>
                                <Text style={styles.emptySub}>{error instanceof Error ? error.message : ''}</Text>
                            </>
                        ) : (
                            <Text style={styles.emptyText}>还没有会话</Text>
                        )}
                    </View>
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    newBtn: {
        margin: 12,
        backgroundColor: colors.accent,
        borderRadius: 10,
        paddingVertical: 12,
        alignItems: 'center',
    },
    newBtnText: { color: '#0b0e14', fontWeight: '700', fontSize: 15 },
    err: { color: colors.err, fontSize: 12, marginHorizontal: 16, marginBottom: 4 },
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
    cover: { width: 42, height: 56, borderRadius: 4, backgroundColor: colors.cardAlt },
    coverFallback: { backgroundColor: colors.accentDim, alignItems: 'center', justifyContent: 'center' },
    coverInitial: { color: colors.text, fontSize: 17, fontWeight: '700' },
    rowBody: { flex: 1 },
    rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    rowSub: { color: colors.dim, fontSize: 12, marginTop: 4 },
    chev: { color: colors.dim, fontSize: 20 },
    emptyGrow: { flexGrow: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyText: { color: colors.sub, fontSize: 15 },
    emptySub: { color: colors.dim, fontSize: 12, marginTop: 8, textAlign: 'center' },
});
