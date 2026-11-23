// visualViewport → --vv-kbd:软键盘遮挡高度写根变量,composer/sheet/弹层锚位
// 经 var() 消费(CSS 侧决策见 spec.css 移动壳段)。挂 MobileFrame 一处:
// 桌面不挂,卸载复位 0px。rAF 合帧 —— 键盘动画期 resize 连发不逐帧写。
import { useEffect } from 'react';
import { computeKeyboardInset } from './mobileShell';

export function useViewportInset(): void {
    useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return; /* 无 visualViewport 的环境(老内核)→ var 缺省 0px */
        const root = document.documentElement;
        let raf = 0;
        const update = () => {
            raf = 0;
            const kbd = computeKeyboardInset(window.innerHeight, vv.height, vv.offsetTop, vv.scale);
            root.style.setProperty('--vv-kbd', `${kbd}px`);
        };
        const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
        vv.addEventListener('resize', schedule);
        vv.addEventListener('scroll', schedule);
        update();
        return () => {
            vv.removeEventListener('resize', schedule);
            vv.removeEventListener('scroll', schedule);
            if (raf) cancelAnimationFrame(raf);
            root.style.setProperty('--vv-kbd', '0px');
        };
    }, []);
}
