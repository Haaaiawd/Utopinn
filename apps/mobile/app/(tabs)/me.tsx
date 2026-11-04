// 我的 — 连接设置:server baseUrl(SecureStore 持久化)+ 连通性自检。
// Android 模拟器用 10.0.2.2 指回宿主机;真机要填局域网 IP。
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_BASE_URL } from '../../src/api/session';
import { useSession } from '../../src/state/session';
import { colors } from '../../src/ui/theme';

const CONN_LABEL = { unknown: '未检测', checking: '检测中…', online: '在线', offline: '离线' } as const;
const CONN_COLOR = { unknown: colors.dim, checking: colors.warn, online: colors.ok, offline: colors.err } as const;

export default function MeScreen() {
    const session = useSession();
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState(session.baseUrl);
    const [checking, setChecking] = useState(false);

    // SecureStore 恢复完成后 baseUrl 可能才就位 —— 同步进输入框
    useEffect(() => {
        setDraft(session.baseUrl);
    }, [session.baseUrl]);

    const save = async () => {
        await session.setBaseUrl(draft);
        // baseUrl 变了 → 所有服务端数据缓存作废
        await queryClient.invalidateQueries();
    };

    const check = async () => {
        setChecking(true);
        try {
            await session.check();
        } finally {
            setChecking(false);
        }
    };

    return (
        <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.section}>服务器</Text>
            <View style={styles.card}>
                <Text style={styles.label}>Base URL</Text>
                <TextInput
                    style={styles.input}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={DEFAULT_BASE_URL}
                    placeholderTextColor={colors.dim}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                />
                <Text style={styles.hint}>
                    Android 模拟器:{DEFAULT_BASE_URL} 指向宿主机;{'\n'}真机/模拟器外:填服务端局域网地址(如 http://192.168.x.x:8000)。
                </Text>
                <View style={styles.row}>
                    <Pressable style={styles.btn} onPress={() => void save()}>
                        <Text style={styles.btnText}>保存</Text>
                    </Pressable>
                    <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setDraft(DEFAULT_BASE_URL)}>
                        <Text style={[styles.btnText, { color: colors.sub }]}>恢复默认</Text>
                    </Pressable>
                    <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => void check()} disabled={checking}>
                        <Text style={[styles.btnText, { color: colors.sub }]}>{checking ? '…' : '自检'}</Text>
                    </Pressable>
                </View>
            </View>

            <Text style={styles.section}>状态</Text>
            <View style={styles.card}>
                <View style={styles.statusRow}>
                    <View style={[styles.dot, { backgroundColor: CONN_COLOR[session.conn] }]} />
                    <Text style={styles.statusText}>{CONN_LABEL[session.conn]}</Text>
                </View>
                <Text style={styles.hint}>当前:{session.baseUrl}</Text>
                <Text style={styles.hint}>自检打 GET /api/uberge/_kernel;会话 cookie + CSRF 由客户端自动维护。</Text>
            </View>

            <Text style={styles.section}>关于</Text>
            <View style={styles.card}>
                <Text style={styles.about}>Uberge 薄客户端 —— 组装/生成/状态全在服务端,这里只做呈现与转发。</Text>
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 16, paddingBottom: 40 },
    section: { color: colors.sub, fontSize: 12, letterSpacing: 1, marginTop: 18, marginBottom: 8, marginLeft: 4 },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    label: { color: colors.sub, fontSize: 12, marginBottom: 6 },
    input: {
        backgroundColor: colors.bgAlt,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        color: colors.text,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
    },
    hint: { color: colors.dim, fontSize: 12, marginTop: 10, lineHeight: 18 },
    row: { flexDirection: 'row', gap: 8, marginTop: 12 },
    btn: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9 },
    btnGhost: { backgroundColor: colors.cardAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    btnText: { color: '#0b0e14', fontWeight: '600', fontSize: 14 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    dot: { width: 9, height: 9, borderRadius: 5 },
    statusText: { color: colors.text, fontSize: 15, fontWeight: '600' },
    about: { color: colors.sub, fontSize: 13, lineHeight: 20 },
});
