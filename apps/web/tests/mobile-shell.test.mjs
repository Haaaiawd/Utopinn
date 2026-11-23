/**
 * mobileShell 纯件单测 —— 移动端硬化(P0 键盘视口 / P2 flick-to-dismiss /
 * 返修:坐标系统一 + 菜单 cap)的裁决函数钉死:
 *   computeKeyboardInset —— layout↔visual 底缘差 ≥140px 才认键盘
 *     (iOS 工具栏 ~85px 差值不误判;Android resizes-content 差值≈0 不二次垫;
 *      pinch 缩放 vvScale>1 几何失真归 0);
 *   sheetDragHeight —— 拖拽跟手高 clamp 在「可用舞台高」availH 内;
 *   resolveSheetSnap —— 甩动(|v|≥0.5px/ms)优先于高阈(>72/>24),
 *     阈值按 sheetH/availH 归一(键盘期 availH = shell 高 − --vv-kbd,
 *     与 CSS max-height cap 同坐标系,拖到 cap 顶仍够 full);
 *   capMenuAbove —— 弹层卡高上限 = 舞台高 − 锚位 − 顶安全距。
 * 跑法:node --test apps/web/tests/mobile-shell.test.mjs
 * (被测 .ts 走 Node>=22.6 type-stripping;纯逻辑零依赖)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeKeyboardInset, resolveSheetSnap, sheetDragHeight, capMenuAbove,
    KEYBOARD_MIN_INSET, SHEET_FLICK_V, SHEET_SNAP_HALF, SHEET_SNAP_FULL,
} from '../src/lib/mobileShell.ts';

test('computeKeyboardInset — iOS 键盘:layout 不缩,vv 缩出全键盘高', () => {
    /* iPhone 竖屏:inner 844,vv 553+offsetTop 0 → inset 291 ≈ 键盘高。 */
    assert.equal(computeKeyboardInset(844, 553, 0), 291);
    /* 页面上顶时 offsetTop 修正:inset 不减虚高。 */
    assert.equal(computeKeyboardInset(844, 553, 20), 271);
});

test('computeKeyboardInset — URL 栏/弹性滚动的小差值不误判', () => {
    /* iOS 底栏 ~60-85px 差 → 0(该场景由 100dvh 链负责,不走 --vv-kbd)。 */
    assert.equal(computeKeyboardInset(844, 762, 0), 0);
    assert.equal(computeKeyboardInset(844, 844, 0), 0);
    /* 阈值边界:139 → 0,140 → 140。 */
    assert.equal(computeKeyboardInset(844, 844 - KEYBOARD_MIN_INSET + 1, 0), 0);
    assert.equal(computeKeyboardInset(844, 844 - KEYBOARD_MIN_INSET, 0), KEYBOARD_MIN_INSET);
});

test('computeKeyboardInset — Android resizes-content:layout 已缩,不二次垫', () => {
    /* 键盘开:innerHeight 随 layout 缩到 553,vv 同值 → inset 0。 */
    assert.equal(computeKeyboardInset(553, 553, 0), 0);
});

test('computeKeyboardInset — pinch 缩放/负差归 0', () => {
    assert.equal(computeKeyboardInset(844, 500, 0, 1.5), 0, 'vvScale>1 不垫');
    assert.equal(computeKeyboardInset(844, 553, 0, 1.05), 291, 'scale=1.05 边界内仍算');
    assert.equal(computeKeyboardInset(600, 700, 0), 0, 'vv 比 layout 还高不垫');
});

test('resolveSheetSnap — 无速度按旧高阈收档(availH=shell 高时)', () => {
    /* availH 取 100px → sheetH 数值即百分比,与旧阈值稿逐点对齐。 */
    assert.equal(resolveSheetSnap(80, 100, 0), 'full');
    assert.equal(resolveSheetSnap(72.01, 100, 0), 'full');
    assert.equal(resolveSheetSnap(72, 100, 0), 'half');
    assert.equal(resolveSheetSnap(50, 100, 0), 'half');
    assert.equal(resolveSheetSnap(24.01, 100, 0), 'half');
    assert.equal(resolveSheetSnap(24, 100, 0), 'closed');
    assert.equal(resolveSheetSnap(10, 100, 0), 'closed');
});

test('resolveSheetSnap — 坐标系统一:键盘 cap 后按可用舞台高归一', () => {
    /* 键盘期 availH=553(shell 844 − kbd 291):sheet 拖到 cap 顶(553)
       仍是 100% avail → full。旧尺(shellH)同此高只得 65.5% 会错掉 half。 */
    assert.equal(resolveSheetSnap(553, 553, 0), 'full');
    assert.equal(resolveSheetSnap(553 * 0.75, 553, 0), 'full');
    assert.equal(resolveSheetSnap(553 * 0.7, 553, 0), 'half');
    assert.equal(resolveSheetSnap(553 * 0.2, 553, 0), 'closed');
    /* 无键盘:availH=shellH,阈值语义与旧稿一致(84.4% → full)。 */
    assert.equal(resolveSheetSnap(712, 844, 0), 'full');
    assert.equal(resolveSheetSnap(450, 844, 0), 'half');
    /* availH=0(壳被键盘吃尽的极端)→ pct 0 → closed,不出 NaN。 */
    assert.equal(resolveSheetSnap(0, 0, 0), 'closed');
});

test('resolveSheetSnap — 甩动越档:flick-to-dismiss / 上甩直全', () => {
    /* 高位下甩 → closed(过半高度也收,不残留 half)。 */
    assert.equal(resolveSheetSnap(60, 100, 0.8), 'closed');
    assert.equal(resolveSheetSnap(90, 100, SHEET_FLICK_V), 'closed');
    /* 低位上甩 → full。 */
    assert.equal(resolveSheetSnap(20, 100, -0.7), 'full');
    assert.equal(resolveSheetSnap(50, 100, -SHEET_FLICK_V), 'full');
    /* 阈值内速度不越档:0.49px/ms 仍按高度走。 */
    assert.equal(resolveSheetSnap(60, 100, 0.49), 'half');
    assert.equal(resolveSheetSnap(10, 100, -0.49), 'closed');
    /* 甩动在键盘 cap 坐标系下同样优先:cap 顶下甩 → closed。 */
    assert.equal(resolveSheetSnap(553, 553, 0.6), 'closed');
});

test('resolveSheetSnap — snap 档与阈值同尺:键盘期下拖不再假展开', () => {
    /* 键盘期 availH=553(shell 844 − kbd 291);CSS snap 高 = 比率 × availH
       (spec.css .vaul-sheet[data-snap] 与 SHEET_SNAP_* 同数)。 */
    const availH = 553;
    const halfH = SHEET_SNAP_HALF * availH; /* ≈298.6 = 54% avail */
    const fullH = SHEET_SNAP_FULL * availH; /* ≈508.8 = 92% avail */
    /* half 起慢拖下 30px → 48.6% → 仍 half。旧稿 CSS 按包含块算 54% 壳高
       =456px(≈82.5% avail),下拖 30px 仍 >72% → 假弹 full —— 钉死。 */
    assert.equal(resolveSheetSnap(halfH - 30, availH, 0), 'half');
    /* full 起慢拖下 30px → 86.6% → 仍 full。 */
    assert.equal(resolveSheetSnap(fullH - 30, availH, 0), 'full');
    /* 跨阈值 → 换档:half 上推过 72% → full;下拉穿 24% → closed。 */
    assert.equal(resolveSheetSnap(availH * 0.75, availH, 0), 'full');
    assert.equal(resolveSheetSnap(availH * 0.2, availH, 0), 'closed');
    /* 键盘 inset 下拖到 cap 顶(100% avail)→ full 可达。 */
    assert.equal(resolveSheetSnap(availH, availH, 0), 'full');
    /* 无键盘(availH=shellH):snap 档语义与旧稿一致,无回归。 */
    assert.equal(resolveSheetSnap(SHEET_SNAP_HALF * 844 - 30, 844, 0), 'half');
    assert.equal(resolveSheetSnap(SHEET_SNAP_FULL * 844 - 30, 844, 0), 'full');
});

test('sheetDragHeight — 拖拽 clamp 在可用舞台高内', () => {
    /* 向上拖(dy 正)不越 availH;向下不穿 0。 */
    assert.equal(sheetDragHeight(300, 400, 553), 553);
    assert.equal(sheetDragHeight(300, -400, 553), 0);
    assert.equal(sheetDragHeight(300, 60, 553), 360);
    /* 无键盘时 availH=shell 高:844 顶满仍不过壳。 */
    assert.equal(sheetDragHeight(450, 500, 844), 844);
    /* availH=0 极端 → 钳 0(松手即 closed,不画负高)。 */
    assert.equal(sheetDragHeight(300, 100, 0), 0);
});

test('capMenuAbove — 菜单卡高上限:舞台高 − 锚位 − 顶安全距', () => {
    /* 无键盘:640 舞台 − 94 锚 − 12 顶距 = 534。 */
    assert.equal(capMenuAbove(640, 94), 534);
    /* 键盘顶起 composer:锚位含 --vv-kbd(94+291=385)→ cap 收紧到 243,
       首行在壳内(旧稿 46vh 定值会溢出被裁)。 */
    assert.equal(capMenuAbove(640, 94 + 291), 243);
    /* 自定义顶距;锚位吃掉舞台 → 0,不画负高。 */
    assert.equal(capMenuAbove(640, 94, 40), 506);
    assert.equal(capMenuAbove(300, 385), 0);
});
