// 半屏层通用壳 —— 书写层/swipe 候选/Aa 设置/段落菜单共用。
// Modal + 半透明背板,点击背板或下滑关闭?先只做背板点击与内嵌关闭钮(可靠优先)。
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ReaderTheme } from './theme';

export interface SheetProps {
    visible: boolean;
    onClose: () => void;
    theme: ReaderTheme;
    /** 顶部小标题(可选)。 */
    title?: string;
    /** 内容区高度占屏比(默认 0.55)。 */
    ratio?: number;
    children: ReactNode;
    /** 内容包 KeyboardAvoidingView(书写层/编辑层需要)。 */
    keyboard?: boolean;
}

export function Sheet({ visible, onClose, theme, title, ratio = 0.55, children, keyboard }: SheetProps) {
    const insets = useSafeAreaInsets();
    const body = (
        <View style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.line, maxHeight: `${Math.round(ratio * 100)}%`, paddingBottom: Math.max(insets.bottom, 12) }]}>
            <View style={[styles.grab, { backgroundColor: theme.line }]} />
            {title != null ? (
                <View style={styles.head}>
                    <Text style={[styles.title, { color: theme.sub }]}>{title}</Text>
                    <Pressable onPress={onClose} hitSlop={12}>
                        <Text style={[styles.close, { color: theme.sub }]}>✕</Text>
                    </Pressable>
                </View>
            ) : null}
            {children}
        </View>
    );
    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
            <View style={styles.root}>
                <Pressable style={styles.backdrop} onPress={onClose} />
                {keyboard ? (
                    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                        {body}
                    </KeyboardAvoidingView>
                ) : body}
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)' },
    card: {
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: 8,
    },
    grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 4 },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 8 },
    title: { fontSize: 13, letterSpacing: 1 },
    close: { fontSize: 15, padding: 4 },
});
