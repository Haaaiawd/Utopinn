// 书页(中间层)— 大封面 + chatName + 「继续阅读」主 CTA(落点=上次阅读
// 位置,progress 在 reader 里恢复)+ 卡描述摘要 + 章节目录入口 + 次操作。
// 非阅读场景 → 深色高对比 palette(深色双轨:阅读低对比只在 reader 里)。
import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { avatarUrl, branchChat, getCharacter, getChat, listCharacters, listChats } from '../../../src/api/client';
import { reading, useProgressMap } from '../../../src/state/reading';
import { buildChapters, buildParas, previewLine } from '../../../src/reader/format';
import { stToView } from '../../../src/api/client';
import { colors } from '../../../src/ui/theme';

export default function BookScreen() {
    const { charDir, chatName, name } = useLocalSearchParams<{ charDir: string; chatName: string; name?: string }>();
    const charName = name || charDir!;
    const chatKey = `${charDir}/${chatName}`;
    const progressMap = useProgressMap();
    const progress = progressMap[chatKey] ?? null;
    const [tocOpen, setTocOpen] = useState(false);
    const [branching, setBranching] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    const chars = useQuery({ queryKey: ['characters'], queryFn: listCharacters });
    const chats = useQuery({ queryKey: ['chats', charDir], queryFn: () => listChats(charDir!), enabled: !!charDir });
    const cardQ = useQuery({ queryKey: ['card', charDir], queryFn: () => getCharacter(charDir!), enabled: !!charDir });
    // 章节目录按需取(打开目录页才拉整卷楼层)
    const chatQ = useQuery({ queryKey: ['chat', charDir, chatName], queryFn: () => getChat(charDir!, chatName!), enabled: tocOpen && !!charDir && !!chatName });

    const me = chars.data?.find((c) => c.charDir === charDir);
    const chatMeta = chats.data?.find((c) => c.name === chatName);
    const uri = avatarUrl(me?.avatar ?? `${charDir}.png`);
    const card = cardQ.data;

    const chapters = useMemo(() => {
        const msgs = chatQ.data?.messages;
        if (!msgs) return [];
        return buildChapters(buildParas(msgs.map((m, i) => stToView(m, i))));
    }, [chatQ.data]);

    const openReader = (atIndex?: number) => {
        router.push({
            pathname: '/reader/[charDir]/[chatName]',
            params: {
                charDir: charDir!, chatName: chatName!, name: charName,
                ...(atIndex != null ? { at: String(atIndex) } : {}),
            },
        });
    };

    return (
        <ScrollView style={styles.root} contentContainerStyle={styles.content}>
            <Stack.Screen options={{ title: chatName ?? '书页' }} />
            <View style={styles.hero}>
                {uri ? (
                    <Image source={{ uri }} style={styles.cover} />
                ) : (
                    <View style={[styles.cover, styles.coverFallback]}>
                        <Text style={styles.coverInitial}>{charName.slice(0, 1)}</Text>
                    </View>
                )}
                <View style={styles.heroBody}>
                    <Text style={styles.title} numberOfLines={2}>{chatName}</Text>
                    <Text style={styles.sub} numberOfLines={1}>{charName}</Text>
                    <Text style={styles.meta} numberOfLines={1}>
                        {chatMeta ? `${chatMeta.messageCount ?? 0} 段` : ''}
                        {progress ? ` · 读到第 ${progress.para + 1} 段` : ''}
                    </Text>
                </View>
            </View>

            <Pressable style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]} onPress={() => openReader()}>
                <Text style={styles.ctaText}>{progress && progress.para > 0 ? '继续阅读' : '开始阅读'}</Text>
            </Pressable>

            <View style={styles.actionRow}>
                <Pressable style={[styles.action, { borderColor: colors.border }]} onPress={() => openReader(0)}>
                    <Text style={[styles.actionText, { color: colors.sub }]}>从头读</Text>
                </Pressable>
                <Pressable
                    style={[styles.action, { borderColor: colors.border }]}
                    onPress={() => {
                        setBranching(true);
                        const d = new Date();
                        const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
                        branchChat(charDir!, chatName!, Number.MAX_SAFE_INTEGER, `${chatName} 分岔 ${stamp}`.slice(0, 120))
                            .then((newName) => {
                                router.push({ pathname: '/book/[charDir]/[chatName]', params: { charDir: charDir!, chatName: newName, name: charName } });
                            })
                            .catch((e) => setNote(`分叉失败:${e instanceof Error ? e.message : String(e)}`))
                            .finally(() => setBranching(false));
                    }}
                    disabled={branching}
                >
                    <Text style={[styles.actionText, { color: colors.sub }]}>{branching ? '分叉中…' : '分叉'}</Text>
                </Pressable>
            </View>
            {note ? <Text style={styles.note}>{note}</Text> : null}

            {card?.description ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>简介</Text>
                    <Text style={styles.desc} numberOfLines={6}>{card.description}</Text>
                </View>
            ) : null}
            {card?.creatorNotes ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>作者注</Text>
                    <Text style={styles.desc} numberOfLines={4}>{card.creatorNotes}</Text>
                </View>
            ) : null}
            {chatMeta?.lastMessage ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>最新一段</Text>
                    <Text style={styles.desc} numberOfLines={3}>{previewLine(chatMeta.lastMessage, 120)}</Text>
                </View>
            ) : null}

            <Pressable style={styles.tocHeader} onPress={() => setTocOpen((v) => !v)}>
                <Text style={styles.sectionTitle}>章节目录</Text>
                <Text style={[styles.tocChev, { color: colors.dim }]}>{tocOpen ? '收起' : '展开'}</Text>
            </Pressable>
            {tocOpen ? (
                <View style={styles.toc}>
                    {chatQ.isLoading ? <Text style={styles.tocHint}>分章中…</Text> : null}
                    {chatQ.isError ? <Text style={styles.tocHint}>目录读不出来</Text> : null}
                    {chapters.map((c) => (
                        <Pressable
                            key={c.index}
                            style={({ pressed }) => [styles.tocRow, pressed && { backgroundColor: colors.card }]}
                            onPress={() => openReader(c.paraStart)}
                        >
                            <Text style={[styles.tocRowText, { color: colors.text }]} numberOfLines={1}>
                                第 {c.index + 1} 章 · {c.title}
                            </Text>
                            <Text style={[styles.tocRowChars, { color: colors.dim }]}>
                                {c.chars >= 1000 ? `${(c.chars / 1000).toFixed(1)}k` : c.chars}字
                            </Text>
                        </Pressable>
                    ))}
                    {chatQ.data && chapters.length === 0 ? <Text style={styles.tocHint}>这本书还是空的</Text> : null}
                </View>
            ) : null}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 18, paddingBottom: 40 },
    hero: { flexDirection: 'row', gap: 16, alignItems: 'flex-end' },
    cover: { width: 120, height: 160, borderRadius: 8, backgroundColor: colors.cardAlt },
    coverFallback: { alignItems: 'center', justifyContent: 'center' },
    coverInitial: { color: colors.sub, fontSize: 40, fontWeight: '700' },
    heroBody: { flex: 1, paddingBottom: 4 },
    title: { color: colors.text, fontSize: 20, fontWeight: '700', lineHeight: 27 },
    sub: { color: colors.sub, fontSize: 13, marginTop: 6 },
    meta: { color: colors.dim, fontSize: 12, marginTop: 8 },
    cta: { backgroundColor: colors.accent, borderRadius: 12, alignItems: 'center', paddingVertical: 13, marginTop: 20 },
    ctaText: { color: '#0b0e14', fontSize: 16, fontWeight: '700' },
    actionRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
    action: { flex: 1, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', paddingVertical: 10 },
    actionText: { fontSize: 14 },
    note: { color: colors.warn, fontSize: 12, marginTop: 10 },
    section: { marginTop: 22 },
    sectionTitle: { color: colors.sub, fontSize: 12, letterSpacing: 1, marginBottom: 8 },
    desc: { color: colors.text, fontSize: 14, lineHeight: 22 },
    tocHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 26, marginBottom: 6 },
    tocChev: { fontSize: 12 },
    toc: { borderRadius: 10, overflow: 'hidden' },
    tocHint: { color: colors.dim, fontSize: 13, paddingVertical: 10 },
    tocRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 4, gap: 8 },
    tocRowText: { flex: 1, fontSize: 14 },
    tocRowChars: { fontSize: 11 },
});
