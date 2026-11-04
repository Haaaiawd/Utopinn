// 面板 — 当前会话的 CardApp(卡内 HTML 应用)沙箱页(TASK-009)。
// 会话定位链:路由参数(阅读器 ⋯「状态面板」)> 页内 chip 点选 >
//           本地面板记忆(panels.last) > 阅读进度最近 > 服务端最近会话。
// 每个会话至多一个面板(card_app 声明挂在角色卡上,chatName 只是变量
// 作用域);切换会话 = key 强制重挂 → 旧 mount 服务端 revoke,新会话
// 重新 mint。卡无面板/无会话 → 诚实空态,不装模作样。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { listAllChats } from '../../src/api/client';
import { kvGet, kvSet } from '../../src/state/kv';
import { useProgressMap } from '../../src/state/reading';
import { PanelWebView } from '../../src/panels/PanelWebView';
import { colors } from '../../src/ui/theme';

interface PanelTarget {
    charDir: string;
    chatName?: string;
    charName?: string;
}

const LAST_KEY = 'panels.lastConversation.v1';
const MAX_CHIPS = 12;

export default function PanelsScreen() {
    const params = useLocalSearchParams<{ charDir?: string; chatName?: string; name?: string }>();
    const progressMap = useProgressMap();
    // 复用书架的同一份查询(同一 queryKey 共享缓存):既兜底「没在本机
    // 读过任何会话」的定位,也喂 chips 列表。
    const chats = useQuery({ queryKey: ['all-chats'], queryFn: listAllChats });

    // 近会话列表(去重):本机阅读进度按 updatedAt 在前,服务端会话补齐。
    const recents = useMemo<PanelTarget[]>(() => {
        const seen = new Map<string, PanelTarget>();
        for (const [key, p] of Object.entries(progressMap).sort((a, b) => b[1].updatedAt - a[1].updatedAt)) {
            const i = key.indexOf('/');
            if (i <= 0) continue;
            const chat = (chats.data ?? []).find((c) => c.id === key);
            seen.set(key, { charDir: key.slice(0, i), chatName: key.slice(i + 1), charName: chat?.charName });
        }
        for (const c of chats.data ?? []) {
            if (!seen.has(c.id)) seen.set(c.id, { charDir: c.charDir, chatName: c.chatName, charName: c.charName });
        }
        return [...seen.values()].slice(0, MAX_CHIPS);
    }, [progressMap, chats.data]);

    // 参数身份变化(阅读器带来新会话)时清掉页内点选,让新参数生效。
    const paramKey = params.charDir ? `${params.charDir}/${params.chatName ?? ''}` : null;
    const lastParamKey = useRef(paramKey);
    const [picked, setPicked] = useState<PanelTarget | null>(null);
    useEffect(() => {
        if (paramKey !== lastParamKey.current) {
            lastParamKey.current = paramKey;
            setPicked(null);
        }
    }, [paramKey]);

    const target = useMemo<PanelTarget | null>(() => {
        if (picked) return picked;
        if (params.charDir) return { charDir: params.charDir, chatName: params.chatName, charName: params.name };
        const last = kvGet<PanelTarget>(LAST_KEY);
        if (last?.charDir) return last;
        return recents[0] ?? null;
    }, [picked, params.charDir, params.chatName, params.name, recents]);

    // 当前目标即「最近面板会话」—— 下次无参数进来时顶它。
    // 依赖会话字段而非 target 对象(kvGet 每次返回新身份,免无效重写)。
    const targetKey = target ? `${target.charDir}/${target.chatName ?? ''}` : null;
    useEffect(() => {
        if (target?.charDir) kvSet(LAST_KEY, target);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetKey]);

    return (
        <View style={styles.root}>
            {recents.length > 0 ? (
                <View style={styles.stripWrap}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
                        {recents.map((r) => {
                            const on = !!target && r.charDir === target.charDir && r.chatName === target.chatName;
                            const label = r.charName ?? r.charDir;
                            return (
                                <Pressable
                                    key={`${r.charDir}/${r.chatName ?? ''}`}
                                    style={[styles.chip, on && styles.chipOn]}
                                    onPress={() => setPicked(r)}
                                >
                                    <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
                                        {label}
                                        <Text style={styles.chipSub}>{r.chatName ? ` · ${r.chatName.slice(0, 14)}` : ''}</Text>
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                </View>
            ) : null}

            {target ? (
                <PanelWebView
                    key={`${target.charDir}/${target.chatName ?? ''}`}
                    charDir={target.charDir}
                    chatName={target.chatName}
                />
            ) : (
                <View style={styles.empty}>
                    <Text style={styles.glyph}>🧩</Text>
                    <Text style={styles.title}>面板</Text>
                    <Text style={styles.sub}>
                        {chats.isError
                            ? '连不上服务器 —— 去「我的」检查连接设置'
                            : chats.isLoading
                                ? '在找当前会话…'
                                : '还没有会话。去书架打开一本书,卡内面板(背包 / 任务卡 / 状态栏)会出现在这里。'}
                    </Text>
                    {!chats.isLoading && !chats.isError ? (
                        <Pressable style={styles.cta} onPress={() => router.push('/')}>
                            <Text style={styles.ctaText}>去书架</Text>
                        </Pressable>
                    ) : null}
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    stripWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    strip: { paddingHorizontal: 10, paddingVertical: 8, gap: 8, alignItems: 'center' },
    chip: {
        borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
        backgroundColor: colors.card, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 200,
    },
    chipOn: { backgroundColor: colors.accentDim, borderColor: colors.accent },
    chipText: { color: colors.sub, fontSize: 12 },
    chipTextOn: { color: colors.text, fontWeight: '600' },
    chipSub: { color: colors.dim, fontSize: 11 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    glyph: { fontSize: 44, marginBottom: 12 },
    title: { color: colors.text, fontSize: 18, fontWeight: '600', marginBottom: 10 },
    sub: { color: colors.sub, fontSize: 13, lineHeight: 21, textAlign: 'center' },
    cta: {
        marginTop: 18, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
        backgroundColor: colors.card, paddingHorizontal: 18, paddingVertical: 8,
    },
    ctaText: { color: colors.accent, fontSize: 14 },
});
