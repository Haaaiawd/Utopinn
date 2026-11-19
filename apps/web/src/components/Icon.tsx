// Phosphor 托底家族 + Utopinn 品牌族(assets/UtopinnIcons,BRAND 表优先)。
// L1 rail 标 = duotone/active(点亮 #FF6B5B 焦段),L2/L3 = regular;尺寸 20/16/12 三档。
// 新图标先查品牌 20 键,无对位再查 phosphor 词表。Emoji 只许出现在用户内容。
// 规范稿(u_ui_codex)的内嵌 SVG 图标表在这里收编成同名键 ——
// 规范组件与老组件共用同一个 <Icon name=…> 组件。
import { UtopinnIcon, type UtopinnIconName } from '../icons/UtopinnIcons';
import {
    ArrowClockwise, ArrowCounterClockwise, ArrowLeft, ArrowRight, ArrowSquareOut, ArrowUp, Book, BookBookmark,
    BookOpen, Books, Brain, Broadcast, Cards, CaretDown, CaretLeft, CaretRight, ChartLine,
    Chats, ChatsCircle, Check, Clock, Code, Command, Copy, CornersIn, CornersOut, Cpu, Database,
    DeviceMobile, DiceFive, DotsThree, DownloadSimple, Eye, EyeClosed, FastForward, Feather, File, Folder, GearSix, GitFork, Globe,
    GridFour, House, Image, Layout, Lightning, Link, List, ListNumbers, MagicWand, MagnifyingGlass, Minus, Monitor,
    Moon, MusicNote, Note, NotePencil, Notebook, Paperclip, PenNib, PencilSimple, Plugs, Plus, Pulse, PushPin, PuzzlePiece,
    ShieldCheck, SidebarSimple, SignOut, Divide, SlidersHorizontal, Sparkle, Square, Stack, Storefront, Sun,
    Terminal, Trash, UploadSimple, User, Warning, X,
    type Icon as PhosphorIcon,
} from '@phosphor-icons/react';

const MAP = {
    /* L1 主 tab 标(duotone)— 各域的表情 */
    foyer: House,
    home: House,
    chat: ChatsCircle,
    stories: Cards,
    rules: BookBookmark,
    extensions: PuzzlePiece,
    settings: GearSix,
    studio: Books,
    plugins: GridFour,
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
    arrowLeft: ArrowLeft,
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
    menu: List,
    layout: Layout,
    grid: GridFour,
    check: Check,
    book: Book,
    bookOpen: BookOpen,
    focus: CornersOut,
    pulse: Pulse,
    globe: Globe,
    chartLine: ChartLine,
    upload: UploadSimple,
    link: Link,
    trash: Trash,
    warning: Warning,
    image: Image,
    pin: PushPin,
    /* —— 规范稿图标表的 phosphor 对位(规范组件直接用这些键) —— */
    slash: Divide,
    detach: ArrowSquareOut,
    dockBack: CornersIn,
    copy: Copy,
    rewind: ArrowCounterClockwise,
    fastForward: FastForward,
    wand: MagicWand,
    paperclip: Paperclip,
    sliders: SlidersHorizontal,
    code: Code,
    terminal: Terminal,
    plug: Plugs,
    database: Database,
    shield: ShieldCheck,
    radio: Broadcast,
    feather: Feather,
    messages: Chats,
    sparkles: Sparkle,
    dice: DiceFive,
    music: MusicNote,
    brain: Brain,
    /* —— 补:规范稿组件用到的其余键 —— */
    monitor: Monitor,
    smartphone: DeviceMobile,
    gear: GearSix,
    chart: ChartLine,
    signOut: SignOut,
    arrowRight: ArrowRight,
    cpu: Cpu,
    pencil: PencilSimple,
    gitFork: GitFork,
    eyeClosed: EyeClosed,
    note: Note,
    notebook: Notebook,
    listNumbers: ListNumbers,
    cards: Cards,
    folder: Folder,
    store: Storefront,
    puzzle: PuzzlePiece,
    penNib: PenNib,
} as const satisfies Record<string, PhosphorIcon>;

export type IconName = keyof typeof MAP | 'persona' | 'branch' | 'compass' | 'bookmark' | 'flame';

/** 品牌族:Utopinn 自家图标(assets/UtopinnIcons),同名键优先于 phosphor。
 *  双色留白规则:weight='duotone' → active=true 点亮 #FF6B5B 焦段;
 *  rail 选中态天然走 duotone,正好吃这条规则。 */
const BRAND = {
    home: 'home', chat: 'chat', studio: 'studio', plugins: 'plugins',
    settings: 'settings', slash: 'slash', send: 'arrowUp',
    panelRight: 'panelRight', menu: 'menu', database: 'database',
    layers: 'layers', sliders: 'sliders', shield: 'shield',
    bookOpen: 'bookOpen', radio: 'radio', code: 'code',
    copy: 'copy', rewind: 'undo', search: 'search', x: 'close',
    gear: 'settings', gitFork: 'branch',
    /* v2 增补:MAP 里已有对位的品牌键 */
    feather: 'feather', messages: 'messages', sparkles: 'sparkles',
    dice: 'dice', music: 'music', brain: 'brain', wand: 'wand',
    /* v2 品牌专属键(MAP 无对位,IconName 经下方联合补入) */
    persona: 'persona', branch: 'branch', compass: 'compass',
    bookmark: 'bookmark', flame: 'flame',
} as const satisfies Record<string, UtopinnIconName>;
export function Icon({ name, size = 17, weight = 'regular', mirrored = false, className }: {
    name: IconName;
    size?: number;
    weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
    /** 镜像 —— panelRight 用 SidebarSimple 翻转得到。 */
    mirrored?: boolean;
    className?: string;
}) {
    const brand = BRAND[name as keyof typeof BRAND];
    if (brand) {
        return <UtopinnIcon name={brand} active={weight === 'duotone'} size={size}
            className={className} style={mirrored ? { transform: 'scaleX(-1)' } : undefined} />;
    }
    const C = MAP[name as keyof typeof MAP];
    return <C size={size} weight={weight} mirrored={mirrored} className={className} aria-hidden="true" />;
}
