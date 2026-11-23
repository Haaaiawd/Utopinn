// 移动壳纯逻辑 —— visualViewport 键盘内边距与 sheet 拖拽收口的裁决函数。
// 零依赖(不引 React/ShellCtx):node --test 直测,hook/组件只做接线。

/** 键盘判定阈值(px):layout↔visual 视口底缘差 ≥ 此值才认作软键盘。
 *  iOS 工具栏收放造成的 innerHeight↔vv.height 常态差约 55–85px,
 *  竖屏软键盘 ≥250px —— 阈值取中,工具栏收放不误判为键盘。 */
export const KEYBOARD_MIN_INSET = 140;

/** sheet 甩动判定(px/ms):|v| ≥ 0.5(≈500px/s)的快速滑动直接越档。 */
export const SHEET_FLICK_V = 0.5;

export type SheetSnapTarget = 'closed' | 'half' | 'full';

/** 视口底缘被软键盘遮住的高度(px)。
 *  innerHeight = layout 视口高;vvHeight/vvTop = visualViewport 高与上偏移。
 *  Android interactive-widget=resizes-content 下 layout 随键盘收缩 →
 *  差值≈0,CSS 链(100dvh)已把 composer 抬上去,不再二次垫;
 *  iOS layout 不缩 → 差值 = 键盘遮挡高(减 offsetTop 修正页面上顶)。
 *  差值 < KEYBOARD_MIN_INSET(URL 栏/弹性滚动抖动)归 0;
 *  vvScale>1( pinch 缩放)时几何失真,同样归 0 不乱垫。 */
export function computeKeyboardInset(
    innerHeight: number,
    vvHeight: number,
    vvOffsetTop: number,
    vvScale = 1,
): number {
    if (vvScale > 1.05) return 0;
    const inset = innerHeight - vvHeight - vvOffsetTop;
    return inset >= KEYBOARD_MIN_INSET ? Math.round(inset) : 0;
}

/** sheet 松手落点:快速下甩(clientY 正增速)直接 closed,快速上甩直接
 *  full;无甩动按高阈收档(>72 full / >24 half / else closed,
 *  与旧 wireMobileSheetDrag 阈值一致)。velocityY 单位 px/ms,向下为正。 */
export function resolveSheetSnap(heightPct: number, velocityY: number): SheetSnapTarget {
    if (velocityY >= SHEET_FLICK_V) return 'closed';
    if (velocityY <= -SHEET_FLICK_V) return 'full';
    return heightPct > 72 ? 'full' : heightPct > 24 ? 'half' : 'closed';
}
