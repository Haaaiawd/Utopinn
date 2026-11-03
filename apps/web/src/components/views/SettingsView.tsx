// Settings — the only view with real controls in the skeleton: theme +
// locale (both are shell-level tokens/dicts, so they're honestly functional).
// The full chain (connection → presets → prompts → …) is a later slice.
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';

export function SettingsView() {
    const { t, locale, setLocale } = useI18n();
    const { theme, toggle } = useTheme();

    return (
        <div className="page-scroll" style={{ maxWidth: 560 }}>
            <div className="sect-title" style={{ marginTop: 0 }}>{t('settings.title')}</div>
            <div className="card" style={{ marginBottom: 14 }}>
                <div className="kv">
                    <label>{t('settings.theme')}</label>
                    <span className="seg">
                        <button type="button" className={theme === 'dark' ? 'on' : ''} onClick={() => theme !== 'dark' && toggle()}>
                            {t('settings.theme.dark')}
                        </button>
                        <button type="button" className={theme === 'light' ? 'on' : ''} onClick={() => theme !== 'light' && toggle()}>
                            {t('settings.theme.light')}
                        </button>
                    </span>
                    <label>{t('settings.locale')}</label>
                    <span className="seg">
                        <button type="button" className={locale === 'zh-CN' ? 'on' : ''} onClick={() => setLocale('zh-CN')}>中文</button>
                        <button type="button" className={locale === 'en' ? 'on' : ''} onClick={() => setLocale('en')}>English</button>
                    </span>
                </div>
            </div>
            <div className="card">
                <div className="sect-title" style={{ marginTop: 0 }}>{t('settings.chain')}</div>
                <p className="mut" style={{ fontSize: 11.5, lineHeight: 1.8 }}>{t('settings.chainNote')}</p>
            </div>
        </div>
    );
}
