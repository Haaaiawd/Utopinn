// Chip — 筛选/动作小胶囊(书架 filter、面板会话选择等)。原语层第一块:
// 选中态 accentDim 底 + accent 边,未选 card 底 + border 发线。
// className 化在 uniwind 接通后做;本文件先用 token+style 保形状稳定。
import { Pressable, StyleSheet, Text, type GestureResponderEvent } from 'react-native';
import { colors } from './theme';

export interface ChipProps {
    label: string;
    on?: boolean;
    onPress?: (e: GestureResponderEvent) => void;
    /** 右侧小注(如计数),不置色。 */
    note?: string;
}

export function Chip({ label, on, onPress, note }: ChipProps) {
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [
                styles.chip,
                on && styles.chipOn,
                pressed && { opacity: 0.75 },
            ]}
        >
            <Text style={[styles.text, on && styles.textOn]} numberOfLines={1}>
                {label}
                {note ? ` ${note}` : ''}
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    chip: {
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        backgroundColor: colors.card,
        paddingHorizontal: 12,
        paddingVertical: 5,
    },
    chipOn: { backgroundColor: colors.accentDim, borderColor: colors.accent },
    text: { color: colors.sub, fontSize: 12 },
    textOn: { color: colors.text, fontWeight: '600' },
});
