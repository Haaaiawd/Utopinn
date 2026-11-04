// Phosphor 单一家族(web-visual-system.md §icon 体系):
// L1 rail 标 = duotone(有性格),L2/L3 = regular;尺寸 20/16/12 三档。
// 新增图标先查 phosphor 词表,禁混第二套库。Emoji 只许出现在用户内容。
import {
    ArrowClockwise, ArrowUp, Book, BookBookmark, Cards, CaretDown, CaretLeft,
    CaretRight, ChatsCircle, Check, Clock, Command, CornersOut, DotsThree,
    DownloadSimple, Eye, File, GearSix, GridFour, Layout, Lightning, List,
    MagnifyingGlass, Minus, Moon, NotePencil, Plus, PuzzlePiece, SidebarSimple,
    Square, Stack, Sun, User, X,
    type Icon as PhosphorIcon,
} from '@phosphor-icons/react';

const MAP = {
    /* L1 主 tab 标(duotone)— 各域的表情 */
    chat: ChatsCircle,
    stories: Cards,
    rules: BookBookmark,
    extensions: PuzzlePiece,
    settings: GearSix,
    /* L2/L3 操作与行内标(regular) */
    search: MagnifyingGlass,
    plus: Plus,
    send: ArrowUp,
    refresh: ArrowClockwise,
    panelRight: SidebarSimple,
    sidebarLeft: SidebarSimple,
    chevronDown: CaretDown,
    chevronRight: CaretRight,
    chevronLeft: CaretLeft,
    edit: NotePencil,
    more: DotsThree,
    x: X,
    minus: Minus,
    square: Square,
    moon: Moon,
    sun: Sun,
    eye: Eye,
    import: DownloadSimple,
    zap: Lightning,
    command: Command,
    clock: Clock,
    user: User,
    layers: Stack,
    file: File,
    list: List,
    layout: Layout,
    grid: GridFour,
    check: Check,
    book: Book,
    focus: CornersOut,
} as const satisfies Record<string, PhosphorIcon>;

export type IconName = keyof typeof MAP;

export function Icon({ name, size = 17, weight = 'regular', mirrored = false, className }: {
    name: IconName;
    size?: number;
    weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
    /** 镜像 —— panelRight 用 SidebarSimple 翻转得到。 */
    mirrored?: boolean;
    className?: string;
}) {
    const C = MAP[name];
    return <C size={size} weight={weight} mirrored={mirrored} className={className} aria-hidden="true" />;
}
