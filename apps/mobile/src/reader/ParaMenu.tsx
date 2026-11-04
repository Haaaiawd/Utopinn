// 长按段落操作菜单 —— design §2 手势:重写此段 / 编辑 / 从此分叉 / 复制。
// 动作语义全在宿主(RendererActions),这里只是触发面。
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ReaderTheme } from './theme';

export interface ParaAction {
    key: string;
    label: string;
    /** 'danger' 用警示色。 */
    tone?: 'default' | 'danger';
    disabled?: boolean;
}

export interface ParaMenuProps {
    visible: boolean;
    theme: ReaderTheme;
    actions: ParaAction[];
    onPick: (key: string) => void;
    onClose: () => void;
}

export function ParaMenu({ visible, theme, actions, onPick, onClose }: ParaMenuProps) {
    const insets = useSafeAreaInsets();
    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
            <View style={styles.root}>
                <Pressable style={styles.backdrop} onPress={onClose} />
                <View style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.line, marginBottom: Math.max(insets.bottom, 16) + 40 }]}>
                    {actions.map((a, i) => (
                        <Pressable
                            key={a.key}
                            disabled={a.disabled}
                            onPress={() => onPick(a.key)}
                            style={({ pressed }) => [
                                styles.row,
                                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
                                pressed && { opacity: 0.6 },
                                a.disabled && { opacity: 0.35 },
                            ]}
                        >
                            <Text style={[styles.label, { color: a.tone === 'danger' ? '#C05046' : theme.ink }]}>
                                {a.label}
                            </Text>
                        </Pressable>
                    ))}
                    <Pressable
                        onPress={onClose}
                        style={({ pressed }) => [styles.row, styles.cancel, { borderTopColor: theme.line }, pressed && { opacity: 0.6 }]}
                    >
                        <Text style={[styles.label, { color: theme.sub }]}>取消</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' },
    card: {
        width: '76%',
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
    },
    row: { paddingVertical: 14, alignItems: 'center' },
    cancel: { borderTopWidth: 6 },
    label: { fontSize: 15 },
});
