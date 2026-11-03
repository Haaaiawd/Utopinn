// sanitize.ts — sanitize-filename 的最小兼容实现(charx 资产落盘名用)。
// 覆盖其默认行为主体:非法字符剔除、结尾点/空格剔除、长度截断。
const ILLEGAL = /[\/\?<>\\:\*\|"\x00-\x1f]/g;

export function sanitizeFilename(name: string): string {
    let s = String(name).replace(ILLEGAL, '');
    s = s.replace(/[. ]+$/, ''); // Windows 不允许结尾点/空格
    if (s === '' || /^\.+$/.test(s)) return '';
    return s.slice(0, 255);
}
