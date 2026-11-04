// 书写层 —— 「——轮到你落笔」呼出的半屏输入(design §2 你的回合):
// 输入区 + 快捷符 *动作 "台词 (OOC;发送后由宿主打 appendMessages→generate。
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Sheet } from './Sheet';
import type { ReaderTheme } from './theme';

export interface ComposeSheetProps {
    visible: boolean;
    theme: ReaderTheme;
    busy?: boolean;
    onSend: (text: string) => void;
    onClose: () => void;
}

interface QuickKey {
    label: string;
    /** 插入的字符(对) */
    pair: [string, string];
    hint: string;
}

const QUICK_KEYS: QuickKey[] = [
    { label: '*动作', pair: ['*', '*'], hint: '*他站起身*' },
    { label: '"台词', pair: ['"', '"'], hint: '"……"' },
    { label: '(OOC', pair: ['(', ')'], hint: '(场外)' },
];

export function ComposeSheet({ visible, theme, busy, onSend, onClose }: ComposeSheetProps) {
    const [draft, setDraft] = useState('');
    const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

    useEffect(() => {
        if (visible) setSel({ start: draft.length, end: draft.length });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    const insertPair = (pair: [string, string]) => {
        const [l, r] = pair;
        const next = draft.slice(0, sel.start) + l + draft.slice(sel.start, sel.end) + r + draft.slice(sel.end);
        const caret = sel.start + l.length + (sel.end - sel.start);
        setDraft(next);
        // selection 是受控 prop —— 写入后光标落在包内
        setSel({ start: caret, end: caret });
    };

    const send = () => {
        const text = draft.trim();
        if (!text || busy) return;
        onSend(text);
        setDraft('');
    };

    return (
        <Sheet visible={visible} onClose={onClose} theme={theme} title="轮到你落笔" ratio={0.6} keyboard>
            <TextInput
                style={[styles.input, { color: theme.ink, borderColor: theme.line, backgroundColor: theme.bg }]}
                value={draft}
                onChangeText={setDraft}
                selection={sel}
                onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
                placeholder="接下一段……"
                placeholderTextColor={theme.inkFaint}
                multiline
                autoFocus
                textAlignVertical="top"
                editable={!busy}
            />
            <View style={styles.quickRow}>
                {QUICK_KEYS.map((k) => (
                    <Pressable
                        key={k.label}
                        style={[styles.quick, { borderColor: theme.line, backgroundColor: theme.chromeBg }]}
                        onPress={() => insertPair(k.pair)}
                    >
                        <Text style={[styles.quickLabel, { color: theme.sub }]}>{k.label}</Text>
                    </Pressable>
                ))}
                <Text style={[styles.quickHint, { color: theme.inkFaint }]}> *动作 "台词 (场外</Text>
            </View>
            <View style={styles.row}>
                <Pressable
                    style={[styles.btn, { backgroundColor: theme.accent }, (busy || !draft.trim()) && { opacity: 0.45 }]}
                    onPress={send}
                    disabled={busy || !draft.trim()}
                >
                    <Text style={styles.btnText}>{busy ? '生成中…' : '落笔'}</Text>
                </Pressable>
            </View>
        </Sheet>
    );
}

const styles = StyleSheet.create({
    input: {
        marginHorizontal: 16,
        marginTop: 6,
        minHeight: 110,
        maxHeight: 200,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 16,
        lineHeight: 24,
    },
    quickRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10 },
    quick: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 4 },
    quickLabel: { fontSize: 12 },
    quickHint: { fontSize: 11, flex: 1 },
    row: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 14 },
    btn: { flex: 1, borderRadius: 10, alignItems: 'center', paddingVertical: 11 },
    btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
