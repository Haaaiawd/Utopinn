// Aa 阅读设置面板 —— design §4 v1 子集:
// 亮度(跟随系统+手动叠层)/字号14-26/行距四档/字体三选/背景五色/
// 对话高亮/页缘翻章/user 标识/页内章名。改动实时生效并持久化(TypingSettings 落地)。
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, LINE_HEIGHT_STOPS, type ReaderFontKey, type ReadingSettings } from '../state/reading';
import { Sheet } from './Sheet';
import { Slider } from './Slider';
import { READER_THEMES, THEME_ORDER, type ReaderTheme } from './theme';

export interface AaPanelProps {
    visible: boolean;
    theme: ReaderTheme;
    settings: ReadingSettings;
    onPatch: (patch: Partial<ReadingSettings>) => void;
    onClose: () => void;
}

function Label({ theme, children }: { theme: ReaderTheme; children: string }) {
    return <Text style={[styles.label, { color: theme.sub }]}>{children}</Text>;
}

function Seg<T extends string | number>({ theme, options, value, onPick }: {
    theme: ReaderTheme;
    options: { value: T; label: string }[];
    value: T;
    onPick: (v: T) => void;
}) {
    return (
        <View style={styles.segRow}>
            {options.map((o) => {
                const on = o.value === value;
                return (
                    <Pressable
                        key={String(o.value)}
                        style={[styles.seg, { borderColor: on ? theme.accent : theme.line, backgroundColor: on ? theme.chromeBg : 'transparent' }]}
                        onPress={() => onPick(o.value)}
                    >
                        <Text style={[styles.segText, { color: on ? theme.accent : theme.sub }]}>{o.label}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

function ToggleRow({ theme, label, value, onChange }: { theme: ReaderTheme; label: string; value: boolean; onChange: (v: boolean) => void }) {
    return (
        <View style={styles.toggleRow}>
            <Text style={[styles.toggleLabel, { color: theme.ink }]}>{label}</Text>
            <Switch value={value} onValueChange={onChange} trackColor={{ true: theme.accent, false: theme.line }} />
        </View>
    );
}

const FONT_OPTIONS: { value: ReaderFontKey; label: string }[] = [
    { value: 'system', label: '系统' },
    { value: 'songti', label: '宋体' },
    { value: 'kaiti', label: '楷体' },
];

export function AaPanel({ visible, theme, settings, onPatch, onClose }: AaPanelProps) {
    return (
        <Sheet visible={visible} onClose={onClose} theme={theme} title="阅读设置" ratio={0.72}>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
                <View style={styles.rowHead}>
                    <Label theme={theme}>亮度</Label>
                    <View style={styles.followRow}>
                        <Text style={[styles.followText, { color: theme.sub }]}>跟随系统</Text>
                        <Switch
                            value={settings.dim === 0}
                            onValueChange={(follow) => onPatch({ dim: follow ? 0 : 0.25 })}
                            trackColor={{ true: theme.accent, false: theme.line }}
                        />
                    </View>
                </View>
                <Slider
                    theme={theme}
                    min={0}
                    max={45}
                    step={1}
                    value={Math.round(settings.dim * 100)}
                    onChange={(v) => onPatch({ dim: v / 100 })}
                />

                <View style={styles.rowHead}>
                    <Label theme={theme}>字号</Label>
                    <Text style={[styles.valueText, { color: theme.ink }]}>{settings.fontSize}</Text>
                </View>
                <Slider
                    theme={theme}
                    min={FONT_SIZE_MIN}
                    max={FONT_SIZE_MAX}
                    step={1}
                    value={settings.fontSize}
                    onChange={(v) => onPatch({ fontSize: v })}
                />

                <Label theme={theme}>行距</Label>
                <Seg
                    theme={theme}
                    options={[
                        { value: LINE_HEIGHT_STOPS[0], label: '紧凑' },
                        { value: LINE_HEIGHT_STOPS[1], label: '适中' },
                        { value: LINE_HEIGHT_STOPS[2], label: '舒适' },
                        { value: LINE_HEIGHT_STOPS[3], label: '疏朗' },
                    ]}
                    value={settings.lineHeight}
                    onPick={(v) => onPatch({ lineHeight: v })}
                />

                <Label theme={theme}>字体</Label>
                <Seg theme={theme} options={FONT_OPTIONS} value={settings.fontKey} onPick={(v) => onPatch({ fontKey: v })} />

                <Label theme={theme}>背景</Label>
                <View style={styles.swatchRow}>
                    {THEME_ORDER.map((k) => {
                        const t = READER_THEMES[k];
                        const on = settings.theme === k;
                        return (
                            <Pressable key={k} style={styles.swatchCol} onPress={() => onPatch({ theme: k })}>
                                <View style={[
                                    styles.swatch,
                                    { backgroundColor: t.bg, borderColor: on ? theme.accent : theme.line },
                                    on && { borderWidth: 2 },
                                ]}>
                                    <Text style={{ color: t.ink, fontSize: 15 }}>字</Text>
                                </View>
                                <Text style={[styles.swatchLabel, { color: on ? theme.accent : theme.sub }]}>{t.label}</Text>
                            </Pressable>
                        );
                    })}
                </View>

                <ToggleRow theme={theme} label="对话引号高亮" value={settings.quoteHighlight} onChange={(v) => onPatch({ quoteHighlight: v })} />
                <ToggleRow theme={theme} label="页缘点击翻章" value={settings.edgeTapTurn} onChange={(v) => onPatch({ edgeTapTurn: v })} />
                <ToggleRow theme={theme} label="「我」段落侧标线" value={settings.userMark} onChange={(v) => onPatch({ userMark: v })} />
                <ToggleRow theme={theme} label="页内显示章节名" value={settings.chapterTitleInPage} onChange={(v) => onPatch({ chapterTitleInPage: v })} />
            </ScrollView>
        </Sheet>
    );
}

const styles = StyleSheet.create({
    scroll: { paddingHorizontal: 20 },
    content: { paddingBottom: 12 },
    label: { fontSize: 12, letterSpacing: 1, marginTop: 14, marginBottom: 6 },
    rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    valueText: { fontSize: 13, fontWeight: '600', marginTop: 10 },
    followRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    followText: { fontSize: 12 },
    segRow: { flexDirection: 'row', gap: 8 },
    seg: { flex: 1, borderRadius: 8, borderWidth: 1, alignItems: 'center', paddingVertical: 8 },
    segText: { fontSize: 13 },
    swatchRow: { flexDirection: 'row', gap: 10 },
    swatchCol: { alignItems: 'center', gap: 5 },
    swatch: { width: 44, height: 60, borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    swatchLabel: { fontSize: 11 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
    toggleLabel: { fontSize: 14 },
});
