// 我的 — 连接设置:server baseUrl(SecureStore 持久化)+ 连通性自检
// + 账户登录(enableUserAccounts 部署:handle+password → cookie-session,
// jar 落 SecureStore 免重登;accounts-off 恒 default-user,本节可忽略)。
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
    const [handle, setHandle] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [authMsg, setAuthMsg] = useState<string | null>(null);

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

    // 登录换 handle = 换数据命名空间 —— 与换 baseUrl 同级,全量 invalidate。
    // accounts-off 的 default-user 无密码(服务端 user.password 空→跳过校验),
    // handle 留空按 default-user 走;密码框空值合法。
    const login = async () => {
        setBusy(true);
        setAuthMsg(null);
        try {
            const r = await session.login(handle.trim() || 'default-user', password);
            setAuthMsg(`已登录:${r.handle}`);
            setPassword('');
            await queryClient.invalidateQueries();
        } catch (e) {
            setAuthMsg(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    const logout = async () => {
        setBusy(true);
        setAuthMsg(null);
        try {
            await session.logout();
            await queryClient.invalidateQueries();
        } finally {
            setBusy(false);
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

            <Text style={styles.section}>账户</Text>
            <Card>
                <Card.Body>
                    {session.handle ? (
                        <>
                            <View style={styles.statusRow}>
                                <View style={[styles.dot, { backgroundColor: colors.ok }]} />
                                <Text style={styles.statusText}>已登录:{session.handle}</Text>
                            </View>
                            <View style={styles.row}>
                                <Button variant="outline" size="sm" onPress={() => void logout()} isDisabled={busy}>
                                    退出登录
                                </Button>
                            </View>
                        </>
                    ) : (
                        <>
                            <TextField>
                                <Label>Handle</Label>
                                <Input
                                    value={handle}
                                    onChangeText={setHandle}
                                    placeholder="default-user"
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </TextField>
                            <TextField>
                                <Label>密码</Label>
                                <Input
                                    value={password}
                                    onChangeText={setPassword}
                                    placeholder="账户未设密码可留空"
                                    secureTextEntry
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                                <Description>
                                    enableUserAccounts 部署的登录面(cookie-session);
                                    登录后 jar 落 SecureStore,重启 App 免重登。
                                </Description>
                            </TextField>
                            <View style={styles.row}>
                                <Button variant="primary" size="sm" onPress={() => void login()} isDisabled={busy}>
                                    {busy ? '登录中…' : '登录'}
                                </Button>
                            </View>
                        </>
                    )}
                    {authMsg ? <Text style={styles.authMsg}>{authMsg}</Text> : null}
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
    authMsg: { color: colors.sub, fontSize: 12, marginTop: 10 },
    mt: { marginTop: 10 },
});
