// 中央舞台出口 —— 'chat' 域 view 的宿主:按当前会话 stage 形态
// 从 'stage.form' 贡献点取内容组件。壳不枚举形态;未注册形态回落 'chat'。
import { useContribs, useShell } from '../../kernel/context';
import { ChatView } from '../chat/ChatView';

export function CenterStage() {
    const { chat } = useShell();
    const forms = useContribs('stage.form');
    const kind = chat?.stage ?? 'chat';
    const C = forms.find((f) => f.kind === kind)?.Component
        ?? forms.find((f) => f.kind === 'chat')?.Component;
    return <div className="flex h-full min-h-0 flex-1 flex-col">{C ? <C /> : <ChatView />}</div>;
}
