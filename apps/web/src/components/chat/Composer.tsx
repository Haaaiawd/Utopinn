// Composer — host chrome under the reading zone. Sending is a local draft
// append in the skeleton: /api/uberge/generate wiring is the next slice, the
// button is labelled honestly via the status hint.
import { useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
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

    const submit = () => {
        const v = text.trim();
        if (!v) return;
        onSend(v);
        setText('');
        areaRef.current?.focus();
    };

    return (
        <div className="composer">
            <div className="composer-inner">
                <div className="composer-box">
                    <textarea
                        ref={areaRef}
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
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button type="button" className="preset-pick">
                                    <Icon name="zap" size={12} />
                                    <span>default</span>
                                    <Icon name="chevronDown" size={11} />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent side="top" align="start">
                                <DropdownMenuLabel>{t('diag.preset')}</DropdownMenuLabel>
                                {/* 骨架期只有 default 一档;多预设接入时这里长出真列表。 */}
                                <DropdownMenuItem disabled>
                                    <Icon name="zap" size={12} />
                                    default
                                </DropdownMenuItem>
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
                            <Icon name="send" size={14} />
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
