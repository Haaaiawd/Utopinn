// Root layout: query client + connection session restore + dark Stack.
// 脑子全在服务端 —— 这里只做呈现与转发。
// global.css 必须最先加载(uniwind 约定)——组件 import 前注入样式系统。
import '../global.css';
import { useEffect, useSyncExternalStore } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { HeroUINativeProvider } from 'heroui-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { session } from '../src/api/session';
import { colors } from '../src/ui/theme';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, staleTime: 15_000 },
    },
});

export default function RootLayout() {
    useEffect(() => {
        void session.load();
    }, []);
    // SecureStore 恢复完成前不发请求 —— 否则首屏可能打到默认 baseUrl
    const ready = useSyncExternalStore(session.subscribe, () => session.loaded);

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <SafeAreaProvider>
                <QueryClientProvider client={queryClient}>
                    <HeroUINativeProvider config={{ textProps: { minimumFontScale: 0.5, maxFontSizeMultiplier: 1.5 } }}>
                        <StatusBar style="light" />
                        {ready ? (
                            <Stack
                                screenOptions={{
                                    headerStyle: { backgroundColor: colors.bg },
                                    headerTintColor: colors.text,
                                    headerTitleStyle: { fontSize: 17 },
                                    contentStyle: { backgroundColor: colors.bg },
                                }}
                            >
                                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                            </Stack>
                        ) : (
                            <View style={styles.boot}>
                                <ActivityIndicator color={colors.sub} />
                            </View>
                        )}
                    </HeroUINativeProvider>
                </QueryClientProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    boot: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
});
