// Title bar — desktop-shell style (IA §14): menus left, centered app name,
// window controls right. In a real browser tab the controls are decorative
// placeholders for a future desktop wrapper; the View menu items are real.
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import { Icon } from '../Icon';

interface MenuItem {
    label: string;
    kbd?: string;
    action?: () => void;
    sep?: boolean;
}

function Menu({ label, items, open, onOpen, onClose }: {
    label: string;
    items: MenuItem[];
    open: boolean;
    onOpen: () => void;
    onClose: () => void;
}) {
    return (
        <div style={{ position: 'relative' }}>
            <button type="button" className={open ? 'open' : ''}
                onClick={() => (open ? onClose() : onOpen())}>
                {label}
            </button>
            {open && (
                <div className="tb-pop">
                    {items.map((it, i) => it.sep
                        ? <hr key={i} />
                        : (
                            <button key={i} type="button" onClick={() => { onClose(); it.action?.(); }}>
                                <span>{it.label}</span>
                                {it.kbd && <span className="kbd">{it.kbd}</span>}
                            </button>
                        ))}
                </div>
            )}
        </div>
    );
}

export function TitleBar({ onToggleSidebar, onTogglePanel, onNewChat, onHint }: {
    onToggleSidebar: () => void;
    onTogglePanel: () => void;
    onNewChat: () => void;
    onHint: (msg: string) => void;
}) {
    const { t } = useI18n();
    const { toggle } = useTheme();
    const [open, setOpen] = useState<'file' | 'view' | 'help' | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const close = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(null);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    const stub = () => onHint(t('menu.stub'));

    return (
        <div className="titlebar" ref={ref}>
            <div className="tb-menu">
                <Menu label={t('menu.file')} open={open === 'file'}
                    onOpen={() => setOpen('file')} onClose={() => setOpen(null)}
                    items={[
                        { label: t('menu.file.newChat'), kbd: '⌘N', action: onNewChat },
                        { label: t('menu.file.import'), kbd: '⌘I', action: stub },
                    ]} />
                <Menu label={t('menu.view')} open={open === 'view'}
                    onOpen={() => setOpen('view')} onClose={() => setOpen(null)}
                    items={[
                        { label: t('menu.view.toggleSidebar'), kbd: '⌘B', action: onToggleSidebar },
                        { label: t('menu.view.togglePanel'), kbd: '⌘J', action: onTogglePanel },
                        { label: t('menu.view.toggleTheme'), action: () => toggle() },
                    ]} />
                <Menu label={t('menu.help')} open={open === 'help'}
                    onOpen={() => setOpen('help')} onClose={() => setOpen(null)}
                    items={[{ label: t('menu.help.about'), action: stub }]} />
            </div>
            <span className="app-name">{t('app.name')}</span>
            <span className="grow" />
            <div className="win-ctl" aria-hidden="true">
                <button type="button" tabIndex={-1}><Icon name="minus" size={13} /></button>
                <button type="button" tabIndex={-1}><Icon name="square" size={12} /></button>
                <button type="button" className="close" tabIndex={-1}><Icon name="x" size={14} /></button>
            </div>
        </div>
    );
}
