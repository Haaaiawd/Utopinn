// Bottom navigation — 对话 / 角色 / 面板 / 我的.
// No icon font package is installed, so tab glyphs are emoji.
import { Tabs } from 'expo-router';
import { Text, StyleSheet } from 'react-native';
import { colors } from '../../src/ui/theme';

function glyph(g: string) {
    return function TabGlyph({ focused }: { color: string; focused: boolean; size: number }) {
        return <Text style={[styles.glyph, !focused && styles.dim]}>{g}</Text>;
    };
}

export default function TabsLayout() {
    return (
        <Tabs
            screenOptions={{
                headerStyle: { backgroundColor: colors.bg },
                headerTintColor: colors.text,
                headerTitleStyle: { fontSize: 17 },
                tabBarStyle: { backgroundColor: colors.bgAlt, borderTopColor: colors.border },
                tabBarActiveTintColor: colors.accent,
                tabBarInactiveTintColor: colors.sub,
                sceneStyle: { backgroundColor: colors.bg },
            }}
        >
            <Tabs.Screen name="index" options={{ title: '对话', tabBarIcon: glyph('💬') }} />
            <Tabs.Screen name="characters" options={{ title: '角色', tabBarIcon: glyph('🎭') }} />
            <Tabs.Screen name="panels" options={{ title: '面板', tabBarIcon: glyph('🧩') }} />
            <Tabs.Screen name="me" options={{ title: '我的', tabBarIcon: glyph('⚙️') }} />
        </Tabs>
    );
}

const styles = StyleSheet.create({
    glyph: { fontSize: 20 },
    dim: { opacity: 0.45 },
});
