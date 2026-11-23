// 导出中心(TASK-067 刀2)—— GET /api/utopinn/export/* 附件面。
// 四类资源:chat(→ST JSONL)/card(→盘上原卡文件,PNG tEXt 即持久化面)/
// world(→{entries:{}} JSON)/preset(→预设整档 JSON)。回出字节与
// import-pipeline 的探测面互认:导出文件直接能回导不丢语义。
// GET 无 CSRF;浏览器锚点下载即触发,不必走 fetch+blob。

export function exportChatUrl(charDir: string, chatName: string): string {
    return `/api/utopinn/export/chat/${encodeURIComponent(charDir)}/${encodeURIComponent(chatName)}`;
}

export function exportCardUrl(charDir: string): string {
    return `/api/utopinn/export/card/${encodeURIComponent(charDir)}`;
}

export function exportWorldUrl(name: string): string {
    return `/api/utopinn/export/world/${encodeURIComponent(name)}`;
}

export function exportPresetUrl(name: string, apiId = 'openai'): string {
    return `/api/utopinn/export/preset/${encodeURIComponent(name)}?apiId=${encodeURIComponent(apiId)}`;
}

/** 锚点下载:同源 GET 自带会话凭据;Content-Disposition 由服务端定名。 */
export function downloadExport(url: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
}
