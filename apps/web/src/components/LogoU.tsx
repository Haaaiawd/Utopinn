// LogoU — 规范稿的 U 字 + Portal Spark 星火组合标(SVG 原样收编)。
// 描边色走 --logo-u-stroke(暗/亮双套),星火恒 #FF6B5B。
export function LogoU({ size = 26 }: { size?: number }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"
            width={size} height={size} fill="none" aria-hidden="true">
            <path d="M 24.5 44 L 24.5 71 A 25.5 25.5 0 0 0 75.36 73.67"
                stroke="var(--logo-u-stroke)" strokeWidth="13.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M 0 -24.2 C 3.1 -24.2 3.8 -9.6 6.7 -6.7 C 9.6 -3.8 24.2 -3.1 24.2 0 C 24.2 3.1 9.6 3.8 6.7 6.7 C 3.8 9.6 3.1 24.2 0 24.2 C -3.1 24.2 -3.8 9.6 -6.7 6.7 C -9.6 3.8 -24.2 3.1 -24.2 0 C -24.2 -3.1 -9.6 -3.8 -6.7 -6.7 C -3.8 -9.6 -3.1 -24.2 0 -24.2 Z"
                fill="#FF6B5B" transform="translate(81 36.5) rotate(15)" />
        </svg>
    );
}
