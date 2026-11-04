// 角色卡半屏 —— 书页「角色卡」/ 阅读器「…」共用:卡字段只读展示。
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CardInfo } from '../api/client';
import { Sheet } from './Sheet';
import type { ReaderTheme } from './theme';

export interface CardSheetProps {
    visible: boolean;
    theme: ReaderTheme;
    card: CardInfo | null;
    avatarUri: string | null;
    loading?: boolean;
    onClose: () => void;
}

function Field({ theme, label, text }: { theme: ReaderTheme; label: string; text: string }) {
    if (!text) return null;
    return (
        <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.sub }]}>{label}</Text>
            <Text style={[styles.fieldText, { color: theme.ink }]}>{text}</Text>
        </View>
    );
}

export function CardSheet({ visible, theme, card, avatarUri, loading, onClose }: CardSheetProps) {
    return (
        <Sheet visible={visible} onClose={onClose} theme={theme} title="角色卡" ratio={0.68}>
            <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 20 }}>
                <View style={styles.headRow}>
                    {avatarUri ? (
                        <Image source={{ uri: avatarUri }} style={[styles.avatar, { borderColor: theme.line }]} />
                    ) : (
                        <View style={[styles.avatar, styles.avatarFallback, { borderColor: theme.line, backgroundColor: theme.chromeBg }]}>
                            <Text style={[styles.avatarInitial, { color: theme.sub }]}>{(card?.name ?? '?').slice(0, 1)}</Text>
                        </View>
                    )}
                    <View style={styles.headBody}>
                        <Text style={[styles.name, { color: theme.ink }]} numberOfLines={2}>{card?.name ?? '…'}</Text>
                        {(card?.tags.length ?? 0) > 0 ? (
                            <View style={styles.tagRow}>
                                {card!.tags.slice(0, 6).map((t) => (
                                    <View key={t} style={[styles.tag, { borderColor: theme.line, backgroundColor: theme.chromeBg }]}>
                                        <Text style={[styles.tagText, { color: theme.sub }]}>{t}</Text>
                                    </View>
                                ))}
                            </View>
                        ) : null}
                    </View>
                </View>
                {loading && !card ? <Text style={[styles.hint, { color: theme.inkFaint }]}>读取卡面中…</Text> : null}
                {!loading && !card ? <Text style={[styles.hint, { color: theme.inkFaint }]}>卡面读不到(可能已被移动或删除)</Text> : null}
                <Field theme={theme} label="描述" text={card?.description ?? ''} />
                <Field theme={theme} label="性格" text={card?.personality ?? ''} />
                <Field theme={theme} label="场景" text={card?.scenario ?? ''} />
                <Field theme={theme} label="作者注" text={card?.creatorNotes ?? ''} />
            </ScrollView>
        </Sheet>
    );
}

const styles = StyleSheet.create({
    scroll: { paddingHorizontal: 18 },
    headRow: { flexDirection: 'row', gap: 12, marginTop: 8, marginBottom: 6 },
    avatar: { width: 64, height: 85, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
    avatarFallback: { alignItems: 'center', justifyContent: 'center' },
    avatarInitial: { fontSize: 26, fontWeight: '700' },
    headBody: { flex: 1, justifyContent: 'center' },
    name: { fontSize: 17, fontWeight: '700' },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
    tag: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingVertical: 3 },
    tagText: { fontSize: 11 },
    hint: { fontSize: 12, marginTop: 12 },
    field: { marginTop: 14 },
    fieldLabel: { fontSize: 11, letterSpacing: 1, marginBottom: 5 },
    fieldText: { fontSize: 14, lineHeight: 21 },
});
