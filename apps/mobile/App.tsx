import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// Planned shell: bottom tabs = 对话 / 角色 / 面板 / 我的.
// 面板 page hosts per-chat CardApp containers (react-native-webview
// sandboxes, ctx bridged over postMessage -> @uberge/api-client).
// All generation + state live on the server; this app is a thin client.
export default function App() {
    return (
        <View style={styles.container}>
            <Text style={styles.title}>Uberge</Text>
            <Text style={styles.sub}>thin client — server does the thinking</Text>
            <StatusBar style="auto" />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#fff',
    },
    title: {
        fontSize: 24,
        fontWeight: '600',
    },
    sub: {
        marginTop: 8,
        color: '#666',
    },
});
