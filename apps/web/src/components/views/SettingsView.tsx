// Settings — the only view with real controls in the skeleton: theme +
// locale (both are shell-level tokens/dicts, so they're honestly functional).
// The full chain (connection → presets → prompts → …) is a later slice.
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { PersonaSection } from './PersonaSection';

export function SettingsView() {
    const { t, locale, setLocale } = useI18n();
    const { theme, toggle } = useTheme();

    return (
        <div className="page-scroll" style={{ maxWidth: 560 }}>
            <div className="sect-title" style={{ marginTop: 0 }}>{t('settings.title')}</div>
            <div className="card" style={{ marginBottom: 14 }}>
                <div className="kv">
                    <label>{t('settings.theme')}</label>
                    <Tabs value={theme} onValueChange={() => toggle()}>
                        <TabsList>
                            <TabsTrigger value="dark">{t('settings.theme.dark')}</TabsTrigger>
                            <TabsTrigger value="light">{t('settings.theme.light')}</TabsTrigger>
                        </TabsList>
                    </Tabs>
                    <label>{t('settings.locale')}</label>
                    <Tabs value={locale} onValueChange={(v) => setLocale(v as 'zh-CN' | 'en')}>
                        <TabsList>
                            <TabsTrigger value="zh-CN">中文</TabsTrigger>
                            <TabsTrigger value="en">English</TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
            </div>
            <div className="card" style={{ marginBottom: 14 }}>
                <div className="sect-title" style={{ marginTop: 0 }}>{t('settings.chain')}</div>
                <p className="mut" style={{ fontSize: 12, lineHeight: 1.8 }}>{t('settings.chainNote')}</p>
            </div>
            <PersonaSection />
        </div>
    );
}
