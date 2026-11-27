// LogoU — brand mark: U ring + Portal Spark.
// Canonical geometry = the brand/favicon.svg vector master (identical paths
// to the shipped favicon.ico / PNG / PWA / touch icons), so the browser tab,
// install icon, sidebar and mobile drawer all render the same mark.
// Stroke follows --logo-u-stroke (dark/light token); spark fixed #FF6B5B.
// viewBox re-anchored onto the ink ring (x 12.1-110.4 / y 8.6-110.4, ink
// center ≈ 61.3,59.5): the raw 120 master frame held the ink 1.3u right and
// 0.5u high — shifted back so `size` centers the mark, ~82-85% ink fill.
export function LogoU({ size = 26 }: { size?: number }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="1.3 -0.5 120 120"
            width={size} height={size} fill="none" aria-hidden="true" style={{ display: 'block' }}>
            <path d="M 20.5 41 L 20.5 72.5 A 29.5 29.5 0 0 0 79.42 74.6"
                stroke="var(--logo-u-stroke)" strokeWidth="16.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M 0 -26.5 C 4.2 -26.5 5.2 -11.4 8.2 -8.2 C 11.4 -5.2 26.5 -4.2 26.5 0 C 26.5 4.2 11.4 5.2 8.2 8.2 C 5.2 11.4 4.2 26.5 0 26.5 C -4.2 26.5 -5.2 11.4 -8.2 8.2 C -11.4 5.2 -26.5 4.2 -26.5 0 C -26.5 -4.2 -11.4 -5.2 -8.2 -8.2 C -5.2 -11.4 -4.2 -26.5 0 -26.5 Z"
                fill="#FF6B5B" transform="translate(84.5 34.5) rotate(12)" />
        </svg>
    );
}
