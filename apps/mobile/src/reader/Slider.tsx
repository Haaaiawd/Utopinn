// 极简滑块 —— RN core 没有 Slider,@react-native-community/slider 未装。
// PanResponder 拖 + 点按跳值;Aa 字号/亮度用。
import { useRef } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import type { ReaderTheme } from './theme';

export interface SliderProps {
    min: number;
    max: number;
    step?: number;
    value: number;
    onChange: (v: number) => void;
    theme: ReaderTheme;
}

const TRACK_H = 4;
const THUMB = 18;

export function Slider({ min, max, step = 1, value, onChange, theme }: SliderProps) {
    const widthRef = useRef(1);
    const valueRef = useRef(value);
    valueRef.current = value;

    const clamp = (x: number) => {
        const ratio = Math.min(1, Math.max(0, x / widthRef.current));
        let v = min + ratio * (max - min);
        v = Math.round(v / step) * step;
        return Math.min(max, Math.max(min, v));
    };

    const pan = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (e) => onChange(clamp(e.nativeEvent.locationX)),
            onPanResponderMove: (e) => onChange(clamp(e.nativeEvent.locationX)),
        }),
    ).current;

    const ratio = max > min ? (value - min) / (max - min) : 0;
    return (
        <View
            style={styles.root}
            onLayout={(e) => {
                widthRef.current = Math.max(1, e.nativeEvent.layout.width);
            }}
            {...pan.panHandlers}
        >
            <View style={[styles.track, { backgroundColor: theme.line }]}>
                <View style={[styles.fill, { backgroundColor: theme.accent, width: `${ratio * 100}%` }]} />
            </View>
            <View style={[styles.thumb, { backgroundColor: theme.accent, left: `${ratio * 100}%` }]} />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { height: 30, justifyContent: 'center' },
    track: { height: TRACK_H, borderRadius: TRACK_H / 2, overflow: 'hidden' },
    fill: { height: TRACK_H },
    thumb: {
        position: 'absolute',
        width: THUMB,
        height: THUMB,
        borderRadius: THUMB / 2,
        marginLeft: -THUMB / 2,
    },
});
