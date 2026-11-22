// 弹层总线 —— 导入中心 / 卡编辑器模态的开合态。
// 刻意不进 ShellCtx:壳上下文字段归 App.tsx(并行编辑期不增键);
// 模态是独立表面,一个小型 external store 就够,任何组件可开可关。
import { useSyncExternalStore } from 'react';

export interface OverlayState {
    /** 导入中心模态(规范稿 importModalOpen)。 */
    importOpen: boolean;
    /** 卡编辑器模态 —— 值为 charDir(规范稿 charEditorId)。 */
    charEditor: string | null;
    /** 新会话卡选择模态 —— newChat() 未指定卡时开。 */
    newChatOpen: boolean;
}

let state: OverlayState = { importOpen: false, charEditor: null, newChatOpen: false };
const listeners = new Set<() => void>();

function patch(p: Partial<OverlayState>): void {
    state = { ...state, ...p };
    for (const l of listeners) l();
}

export const openImportModal = () => patch({ importOpen: true });
export const closeImportModal = () => patch({ importOpen: false });
export const openCharEditor = (charDir: string) => patch({ charEditor: charDir });
export const closeCharEditor = () => patch({ charEditor: null });
export const openNewChatModal = () => patch({ newChatOpen: true });
export const closeNewChatModal = () => patch({ newChatOpen: false });

export function useOverlay(): OverlayState {
    return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        () => state,
        () => state,
    );
}
