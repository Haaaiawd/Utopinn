// 我的 — 连接设置:server baseUrl(SecureStore 持久化)+ 连通性自检。
// Android 模拟器用 10.0.2.2 指回宿主机;真机要填局域网 IP。
// UI 面走 heroui-native(Card/TextField/Button)——chrome 件不再手搓。
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, TextField, Input, Label, Description } from 'heroui-native';
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
            <Card>
                <Card.Body>
                    <TextField>
                        <Label>Base URL</Label>
                        <Input
                            value={draft}
                            onChangeText={setDraft}
                            placeholder={DEFAULT_BASE_URL}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                        />
                        <Description>
                            Android 模拟器:{DEFAULT_BASE_URL} 指向宿主机;
                            真机/模拟器外:填服务端局域网地址(如 http://192.168.x.x:8000)。
                        </Description>
                    </TextField>
                    <View style={styles.row}>
                        <Button variant="primary" size="sm" onPress={() => void save()}>
                            保存
                        </Button>
                        <Button variant="outline" size="sm" onPress={() => setDraft(DEFAULT_BASE_URL)}>
                            恢复默认
                        </Button>
                        <Button variant="outline" size="sm" onPress={() => void check()} isDisabled={checking}>
                            {checking ? '检测中…' : '自检'}
                        </Button>
                    </View>
                </Card.Body>
            </Card>

            <Text style={styles.section}>状态</Text>
            <Card>
                <Card.Body>
                    <View style={styles.statusRow}>
                        <View style={[styles.dot, { backgroundColor: CONN_COLOR[session.conn] }]} />
                        <Text style={styles.statusText}>{CONN_LABEL[session.conn]}</Text>
                    </View>
                    <Card.Description style={styles.mt}>
                        {`当前:${session.baseUrl}\n自检打 GET /api/utopinn/_kernel;会话 cookie + CSRF 由客户端自动维护。`}
                    </Card.Description>
                </Card.Body>
            </Card>

            <Text style={styles.section}>关于</Text>
            <Card>
                <Card.Body>
                    <Card.Description>
                        Utopinn 薄客户端 —— 组装/生成/状态全在服务端,这里只做呈现与转发。
                    </Card.Description>
                </Card.Body>
            </Card>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 16, paddingBottom: 40 },
    section: { color: colors.sub, fontSize: 12, letterSpacing: 1, marginTop: 18, marginBottom: 8, marginLeft: 4 },
    row: { flexDirection: 'row', gap: 8, marginTop: 14 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    dot: { width: 9, height: 9, borderRadius: 5 },
    statusText: { color: colors.text, fontSize: 15, fontWeight: '600' },
    mt: { marginTop: 10 },
});
