// feature:shell — 壳级词条(top chrome/账户 dock/工作台/设置/cmdk/移动壳)。
// 不注册表面;词条归壳域,域词条归各 feature。
import type { Feature } from '../kernel/kernel';

const zh: Record<string, string> = {
    'app.name': 'Utopinn',
    'nav.chat': '聊天', 'nav.home': '资产', 'nav.studio': '工作室', 'nav.plugins': '插件',
    'pane.chat': '会话', 'pane.home': '资产', 'pane.studio': '工作室', 'pane.plugins': '插件',
    'chrome.toggleSidebar': '切换侧栏', 'chrome.vp': '切换视口', 'chrome.workbench': '工作台',
    'settings.title': '设置',
    /* 账户 dock + pop */
    'acct.menu': '账户菜单', 'acct.name': 'haa', 'acct.plan': '已连接', 'acct.mail': 'haa@local',
    'acct.profile': '个人资料', 'acct.usage': '用量', 'acct.theme': '切换主题', 'acct.signout': '登出',
    'acct.signout.hint': '本地壳没有会话 —— 无登出对象',
    /* 工作台 */
    'wb.newtab': '新标签页', 'wb.collapse': '收起工作台', 'wb.dock': '收回工作台', 'wb.close': '关闭',
    'wb.launcher.search': '搜索板块…', 'wb.launcher.new': '新键', 'wb.launcher.suggested': '建议',
    'panel.unregistered': '未注册板块',
    'panel.type.preset': '预设 / 模型', 'panel.type.mvu': 'MVU 变量', 'panel.type.notes': '手记',
    'panel.type.ledger': '云栖宗总簿', 'panel.type.lore': '世界书', 'panel.type.chapters': '章节', 'panel.type.channels': '频道',
    'panel.desc.preset': '预设与生成参数', 'panel.desc.mvu': 'MVU 快照变量', 'panel.desc.notes': '随手记',
    'panel.desc.ledger': 'CardApp 宿主', 'panel.desc.lore': '作品世界书条目', 'panel.desc.chapters': '小说章节目录', 'panel.desc.channels': '群聊频道',
    'panel.badge.cardapp': 'CardApp', 'panel.badge.unwired': '待服务端面',
    'panel.unwired.note': '示例数据 · 服务端面未接,仅供预览。',
    'panel.needChat': '选卡后可用', 'panel.retry': '重试',
    'panel.preset.preset': '预设', 'panel.preset.model': '模型', 'panel.preset.blocks': '提示词条目', 'panel.preset.more': '打开完整预设板块',
    'panel.preset.empty': '该家族还没有预设', 'panel.preset.readonly': '只读 · 写面未接',
    'param.temp': '温度', 'param.topP': 'Top-P', 'param.ctxLen': '上下文', 'param.maxReply': '最大回复',
    'panel.mvu.vars': '变量', 'panel.mvu.table': '表格', 'panel.mvu.bridge': '总簿联动',
    'panel.mvu.empty': '该会话还没有 MVU 变量', 'panel.mvu.receipts': '结算回执',
    'panel.mvu.settle': '重结算', 'panel.mvu.resettle': '重建投影',
    'panel.mvu.floor': '楼', 'panel.mvu.changed': '已改', 'panel.mvu.unchanged': '无变化',
    'bridge.repair': '拨款修缮大殿 (+15 耐久)', 'bridge.stipend': '发放月俸 (+2 声望)', 'bridge.levy': '征收香火钱 (+5 灵石)',
    'panel.mvu.note': '变量读自服务端 stat_data 投影;手动改值可能被下次结算覆盖。',
    'panel.notes.saving': '保存中…', 'panel.notes.saved': '已保存', 'panel.notes.dirty': '有未保存更改',
    'panel.notes.failed': '保存失败', 'panel.notes.conflict': '状态被改,刷新重试', 'panel.notes.reload': '重载',
    'panel.lore.entries': '作品世界书', 'panel.lore.global': '全局常驻',
    'panel.chapters.paras': '段', 'panel.chapters.current': '当前',
    /* ctbar 胶囊 + 弹层 */
    'ctx.capsule': '上下文', 'ctx.title': '世界书注入栈',
    'slash.continue': '让角色继续写', 'slash.regen': '重新生成末楼', 'slash.impersonate': '替你起草一条',
    'composer.placeholder': '回覆掌门线…(Enter 发送,/ 呼出指令)', 'composer.attach': '附件', 'composer.impersonate': '代写', 'composer.send': '发送',
    'chat.none': '未选会话', 'chat.persona': ' Persona',
    'chat.send.failed': '发送失败', 'chat.rename': '重命名会话', 'chat.rename.failed': '重命名失败',
    'chat.delete.confirm': '删除会话?', 'chat.delete.failed': '删除失败', 'sidebar.newChat': '新会话',
    /* 左树 */
    'tree.pinned': '置顶', 'tree.sessions': '会话', 'tree.stages': '舞台形态',
    'tree.pickCard': '选择卡面', 'tree.cardSessions': '角色卡与会话', 'tree.manage': '管理',
    /* 总簿板块 */
    'panel.type.cardapp': '卡面应用', 'panel.desc.cardapp': 'CardApp 真宿主(离线报挂载错误)',
    'panel.cardapp.mountFailed': 'CardApp 挂载失败', 'panel.cardapp.retry': '重试', 'panel.cardapp.ctxDegraded': 'ctx 面未接 · 仅静态渲染',
    'ledger.title': '云栖宗总簿', 'ledger.灵石': '库存灵石', 'ledger.宗门声望': '宗门声望', 'ledger.大殿耐久': '大殿耐久',
    'ledger.repair': '正殿东头修缮度', 'ledger.op.repair': '拨款修缮东头屋瓦', 'ledger.op.repair.cost': '-10 灵石 · +15%',
    'ledger.op.stipend': '发放弟子月俸与灵米', 'ledger.op.stipend.cost': '-6 灵石 · +3 声望',
    'ledger.op.levy': '下山征收香火供奉', 'ledger.op.levy.cost': '+12 灵石',
    'studio.nav.lore': '世界书', 'studio.nav.chars': '角色', 'studio.nav.prompts': '提示词', 'studio.nav.regex': '正则', 'studio.nav.files': '文件',
    'plugins.nav.installed': '已安装', 'plugins.nav.market': '市场',
    /* 状态/导入 */
    'status.stub': '骨架阶段', 'imp.tooLarge': '文件超过 64MB 上限', 'imp.queued': '已加入导入队列', 'imp.veil': '松手导入卡/书/预设',
    /* cmdk + 设置 */
    'cmdk.placeholder': '输入命令或搜索…', 'cmdk.empty': '没有匹配项', 'cmdk.views': '视图', 'cmdk.panels': '板块',
    'st.account': '账户', 'st.api': 'API 连接', 'st.chat': '聊天与消息', 'st.appearance': '外观', 'st.about': '关于',
    'st.renderCount': '渲染消息数', 'st.streamFps': '流式帧率上限', 'st.autoParseThink': '自动解析 think',
    'st.autoExpandThink': '自动展开 think', 'st.showFloorNum': '显示楼层号', 'st.confirmDelete': '删除前确认',
    'st.fontSize': '正文字号', 'st.customCss': '自定义 CSS', 'st.endpoint': '端点', 'st.bgMode': '聊天背景',
    'mob.menu': '菜单', 'mob.hub.home': '首页', 'mob.hub.chat': '会话', 'mob.hub.panels': '面板', 'mob.hub.me': '我的',
};

const en: Record<string, string> = Object.fromEntries(Object.keys(zh).map((k) => [k, k]));

export const shellFeature: Feature = {
    name: 'shell',
    apply(ctx) {
        ctx.locale('shell', { 'zh-CN': zh, en });
    },
};
