// 章节目录抽屉 —— design §2:左缘滑出,章列表带当前章高亮 + 已读灰。
// Modal 自带 slide 只能从底部进,左抽屉用 Animated translateX 自绘。
import { useEffect, useRef } from 'react';
import { Animated, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Chapter } from './format';
import type { ReaderTheme } from './theme';

export interface ChapterDrawerProps {
    visible: boolean;
    theme: ReaderTheme;
    chapters: Chapter[];
    /** 当前视口所在段下标(决定高亮/已读灰)。 */
    currentPara: number;
    onJump: (paraIndex: number) => void;
    onClose: () => void;
}

export function ChapterDrawer({ visible, theme, chapters, currentPara, onJump, onClose }: ChapterDrawerProps) {
    const insets = useSafeAreaInsets();
    const slide = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (visible) {
            Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start();
        } else {
            slide.setValue(0);
        }
    }, [visible, slide]);

    const translateX = slide.interpolate({ inputRange: [0, 1], outputRange: [-320, 0] });
    const fade = slide.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

    return (
        <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
            <View style={styles.root}>
                <Animated.View style={[styles.drawer, {
                    backgroundColor: theme.cardBg,
                    borderRightColor: theme.line,
                    paddingTop: insets.top + 12,
                    paddingBottom: insets.bottom,
                    transform: [{ translateX }],
                }]}>
                    <Text style={[styles.head, { color: theme.sub }]}>目录 · {chapters.length} 章</Text>
                    <FlatList
                        data={chapters}
                        keyExtractor={(c) => String(c.index)}
                        renderItem={({ item }) => {
                            const current = currentPara >= item.paraStart && currentPara < item.paraEnd;
                            const read = currentPara >= item.paraEnd;
                            return (
                                <Pressable
                                    style={({ pressed }) => [styles.row, current && { backgroundColor: theme.chromeBg }, pressed && { opacity: 0.6 }]}
                                    onPress={() => {
                                        onJump(item.paraStart);
                                        onClose();
                                    }}
                                >
                                    <Text
                                        style={[styles.rowText, { color: current ? theme.accent : read ? theme.inkFaint : theme.ink }]}
                                        numberOfLines={1}
                                    >
                                        {item.title}
                                    </Text>
                                    <Text style={[styles.rowChars, { color: theme.inkFaint }]}>
                                        {item.chars >= 1000 ? `${(item.chars / 1000).toFixed(1)}k` : item.chars}
                                    </Text>
                                </Pressable>
                            );
                        }}
                        ListEmptyComponent={<Text style={[styles.empty, { color: theme.inkFaint }]}>还没有章节</Text>}
                    />
                </Animated.View>
                <Animated.View style={[styles.backdropWrap, { opacity: fade }]}>
                    <Pressable style={styles.backdrop} onPress={onClose} />
                </Animated.View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, flexDirection: 'row' },
    drawer: { width: '76%', borderRightWidth: StyleSheet.hairlineWidth },
    backdropWrap: { flex: 1 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    head: { fontSize: 12, letterSpacing: 1, paddingHorizontal: 18, paddingBottom: 10 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 13 },
    rowText: { flex: 1, fontSize: 14 },
    rowChars: { fontSize: 11 },
    empty: { padding: 24, fontSize: 13 },
});
