// feature:shell — 壳级词条(rail chrome/账户菜单/通用徽标/状态语)。
// 不注册表面,只注册 locale —— 壳组件归宿主画,词条归这里管。
import type { Feature } from '../kernel/kernel';

export const shellFeature: Feature = {
    name: 'shell',
    apply(ctx) {
        ctx.locale('shell', {
            'zh-CN': {
                'app.name': 'Uberge',
                'menu.user': '账户',
                'menu.view.toggleSidebar': '切换侧栏',
                'menu.view.toggleTheme': '切换主题',
                'nav.settings': '设置',
                'status.stub': '骨架阶段',
                'common.mockData': '模拟数据 — 服务器未连接',
            },
            en: {
                'app.name': 'Uberge',
                'menu.user': 'Account',
                'menu.view.toggleSidebar': 'Toggle sidebar',
                'menu.view.toggleTheme': 'Toggle theme',
                'nav.settings': 'Settings',
                'status.stub': 'skeleton',
                'common.mockData': 'Mock data — server unreachable',
            },
        });
    },
};
