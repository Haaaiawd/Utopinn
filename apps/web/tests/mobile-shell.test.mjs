/**
 * mobileShell 纯件单测 —— 移动端硬化(P0 键盘视口 / P2 flick-to-dismiss)的
 * 裁决函数钉死:
 *   computeKeyboardInset —— layout↔visual 底缘差 ≥140px 才认键盘
 *     (iOS 工具栏 ~85px 差值不误判;Android resizes-content 差值≈0 不二次垫;
 *      pinch 缩放 vvScale>1 几何失真归 0);
 *   resolveSheetSnap —— 甩动(|v|≥0.5px/ms)优先于高阈(>72/>24),
 *     下甩 closed / 上甩 full / 无速度按旧 wireMobileSheetDrag 高阈。
 * 跑法:node --test apps/web/tests/mobile-shell.test.mjs
 * (被测 .ts 走 Node>=22.6 type-stripping;纯逻辑零依赖)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeKeyboardInset, resolveSheetSnap,
    KEYBOARD_MIN_INSET, SHEET_FLICK_V,
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

test('resolveSheetSnap — 无速度按旧高阈收档', () => {
    assert.equal(resolveSheetSnap(80, 0), 'full');
    assert.equal(resolveSheetSnap(72.01, 0), 'full');
    assert.equal(resolveSheetSnap(72, 0), 'half');
    assert.equal(resolveSheetSnap(50, 0), 'half');
    assert.equal(resolveSheetSnap(24.01, 0), 'half');
    assert.equal(resolveSheetSnap(24, 0), 'closed');
    assert.equal(resolveSheetSnap(10, 0), 'closed');
});

test('resolveSheetSnap — 甩动越档:flick-to-dismiss / 上甩直全', () => {
    /* 高位下甩 → closed(过半高度也收,不残留 half)。 */
    assert.equal(resolveSheetSnap(60, 0.8), 'closed');
    assert.equal(resolveSheetSnap(90, SHEET_FLICK_V), 'closed');
    /* 低位上甩 → full。 */
    assert.equal(resolveSheetSnap(20, -0.7), 'full');
    assert.equal(resolveSheetSnap(50, -SHEET_FLICK_V), 'full');
    /* 阈值内速度不越档:0.49px/ms 仍按高度走。 */
    assert.equal(resolveSheetSnap(60, 0.49), 'half');
    assert.equal(resolveSheetSnap(10, -0.49), 'closed');
});
