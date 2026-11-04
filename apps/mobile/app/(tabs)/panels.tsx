// 面板 — 占位页。CardApp(卡内 HTML 应用)走 react-native-webview 沙箱 +
// postMessage ctx 桥,是 TASK-009 的活,这里只说明。
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../src/ui/theme';

export default function PanelsScreen() {
    return (
        <View style={styles.root}>
            <Text style={styles.glyph}>🧩</Text>
            <Text style={styles.title}>面板</Text>
            <Text style={styles.sub}>
                每个会话的 CardApp(背包 / 任务卡 / 状态面板)会出现在这里。{'\n'}
                react-native-webview 沙箱 + ctx 桥接是 TASK-009,敬请期待。
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32 },
    glyph: { fontSize: 44, marginBottom: 12 },
    title: { color: colors.text, fontSize: 18, fontWeight: '600', marginBottom: 10 },
    sub: { color: colors.sub, fontSize: 13, lineHeight: 21, textAlign: 'center' },
});
