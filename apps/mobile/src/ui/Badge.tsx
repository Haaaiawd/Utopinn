// Badge — 状态小徽标(热度/进度/状态点)。hot=accentDim 实心,calm=发线边。
import { StyleSheet, Text, View } from 'react-native';
import { colors } from './theme';

export function Badge({ text, hot }: { text: string; hot?: boolean }) {
    return (
        <View style={[styles.badge, hot ? styles.hot : styles.calm]}>
            <Text style={[styles.text, hot ? styles.textHot : styles.textCalm]}>{text}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    badge: { alignSelf: 'center', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 3 },
    hot: { backgroundColor: colors.accentDim },
    calm: { backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    text: { fontSize: 10, fontWeight: '600' },
    textHot: { color: colors.text },
    textCalm: { color: colors.sub },
});
