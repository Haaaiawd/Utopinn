// Composer — 舞台底栏(规范稿 composer-shell:2px 粗边 + 聚焦 brand ring +
// 附件/slash/预设胶囊 + 发送圆钮)。发送走宿主流式链;附件/slash 菜单是
// 规范稿占位位(SPEC-DATA: 待接,标 unwired 提示)。
import { useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { useShell } from '../../kernel/context';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export function Composer({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
    const { t } = useI18n();
    const [text, setText] = useState('');
    const areaRef = useRef<HTMLTextAreaElement>(null);
    const { presets, activePresetId, setActivePreset, hint } = useShell();
    const active = presets.find((p) => p.id === activePresetId);

    const submit = () => {
        const v = text.trim();
        if (!v) return;
        onSend(v);
        setText('');
        areaRef.current?.focus();
    };

    const slashCmds = [
        { id: 'regen', icon: 'refresh' as const },
        { id: 'branch', icon: 'list' as const },
        { id: 'note', icon: 'feather' as const },
    ];

    return (
        <div className="composer">
            <div className="composer-inner">
                <div className="composer-box composer-shell">
                    <Textarea
                        ref={areaRef}
                        className="composer-ta border-0 shadow-none focus-visible:border-transparent focus-visible:ring-0"
                        rows={2}
                        value={text}
                        placeholder={t('chat.input.placeholder')}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                submit();
                            }
                        }}
                    />
                    <div className="composer-bar">
                        {/* 附件位 —— SPEC-DATA: 待接 */}
                        <Button type="button" variant="ghost" size="icon-sm" className="composer-tool"
                            title={t('chat.attach')} onClick={() => hint(t('chat.action.unwired'))}>
                            <Icon name="paperclip" size={14} />
                        </Button>
                        {/* slash 命令 —— SPEC-DATA: 待接(宏/STscript 服务端管线) */}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon-sm" className="composer-tool" title="/">
                                    <Icon name="slash" size={14} />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent side="top" align="start">
                                <DropdownMenuLabel>/</DropdownMenuLabel>
                                {slashCmds.map((c) => (
                                    <DropdownMenuItem key={c.id} onClick={() => hint(t('chat.action.unwired'))}>
                                        <Icon name={c.icon} size={12} />/{c.id}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {/* 预设胶囊(规范稿下拉)—— 目录是 ctx mock,已标 SPEC-DATA */}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="sm" className="preset-pick">
                                    <Icon name="zap" size={12} />
                                    <span>{active?.name ?? 'default'}</span>
                                    <Icon name="chevronDown" size={12} />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent side="top" align="start">
                                <DropdownMenuLabel>{t('diag.preset')}</DropdownMenuLabel>
                                {presets.map((p) => (
                                    <DropdownMenuItem key={p.id} onClick={() => setActivePreset(p.id)}>
                                        <Icon name={p.id === activePresetId ? 'check' : 'zap'} size={12} />
                                        {p.name}
                                        <span className="mut" style={{ marginLeft: 'auto' }}>T{p.temp}</span>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <span className="grow" />
                        <Button
                            type="button"
                            size="icon"
                            className="composer-send"
                            title={t('chat.send')}
                            disabled={disabled || !text.trim()}
                            onClick={submit}
                        >
                            <Icon name="send" size={16} />
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
