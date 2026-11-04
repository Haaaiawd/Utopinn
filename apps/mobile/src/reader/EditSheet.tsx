// 段落编辑层 —— 半屏 TextInput 预填楼层正文,保存走 PATCH /body/<i>/mes。
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Sheet } from './Sheet';
import type { ReaderTheme } from './theme';

export interface EditSheetProps {
    visible: boolean;
    theme: ReaderTheme;
    /** 预填文本(floor 激活稿)。null → 不开。 */
    initial: string;
    busy?: boolean;
    onSave: (text: string) => void;
    onClose: () => void;
}

export function EditSheet({ visible, theme, initial, busy, onSave, onClose }: EditSheetProps) {
    const [draft, setDraft] = useState(initial);
    useEffect(() => {
        if (visible) setDraft(initial);
    }, [visible, initial]);

    return (
        <Sheet visible={visible} onClose={onClose} theme={theme} title="编辑这一段" ratio={0.62} keyboard>
            <TextInput
                style={[styles.input, { color: theme.ink, borderColor: theme.line, backgroundColor: theme.bg }]}
                value={draft}
                onChangeText={setDraft}
                multiline
                autoFocus
                textAlignVertical="top"
            />
            <View style={styles.row}>
                <Pressable style={[styles.btn, { backgroundColor: theme.accent }, busy && { opacity: 0.5 }]} onPress={() => onSave(draft)} disabled={busy}>
                    <Text style={styles.btnText}>{busy ? '保存中…' : '保存'}</Text>
                </Pressable>
                <Pressable style={[styles.btn, { backgroundColor: theme.chromeBg, borderColor: theme.line, borderWidth: StyleSheet.hairlineWidth }]} onPress={onClose} disabled={busy}>
                    <Text style={[styles.btnText, { color: theme.sub }]}>取消</Text>
                </Pressable>
            </View>
        </Sheet>
    );
}

const styles = StyleSheet.create({
    input: {
        marginHorizontal: 16,
        marginTop: 6,
        minHeight: 140,
        maxHeight: 260,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 15,
        lineHeight: 22,
    },
    row: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
    btn: { flex: 1, borderRadius: 10, alignItems: 'center', paddingVertical: 11 },
    btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
