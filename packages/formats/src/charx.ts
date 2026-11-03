// charx.ts — RisuAI CharX(zip)解析,移植 apps/server/src/charx.js。
// 纯解析:返回 card + avatar + 资产映射 + 已解包 buffer,落盘交给调用方。
import { unzipEntries, normalizeZipEntryPath } from './zip.js';
import { sanitizeFilename } from './sanitize.js';

// 'embeded://' 是 RisuAI 导出的有意拼写,勿改
export const CHARX_EMBEDDED_URI_PREFIXES = ['embeded://', 'embedded://', '__asset:'];
export const CHARX_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'bmp', 'jfif']);
const CHARX_SPRITE_TYPES = new Set(['emotion', 'expression']);
const CHARX_BACKGROUND_TYPES = new Set(['background']);

const ZIP_SIGNATURE = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function findZipStart(buf: Uint8Array): Uint8Array {
    // 兼容 SFX 自解包:定位 PK\x03\x04
    outer: for (let i = 0; i <= buf.length - 4; i++) {
        for (let j = 0; j < 4; j++) if (buf[i + j] !== ZIP_SIGNATURE[j]) continue outer;
        return i === 0 ? buf : buf.slice(i);
    }
    return buf;
}

export interface CharXAsset {
    type: string;
    name: string;
    ext: string;
    zipPath: string;
    order: number;
    storageCategory?: 'sprite' | 'background' | 'misc';
    baseName?: string;
}

export interface CharXParseResult {
    card: Record<string, unknown>;
    avatar: Uint8Array | null;
    auxiliaryAssets: CharXAsset[];
    extractedBuffers: Map<string, Uint8Array>;
}

export class CharXParser {
    private data: Uint8Array;
    private files: Map<string, Uint8Array> | null = null;

    constructor(data: Uint8Array | ArrayBuffer) {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        this.data = findZipStart(u8);
    }

    private entries(): Map<string, Uint8Array> {
        return (this.files ??= unzipEntries(this.data));
    }

    parse(): CharXParseResult {
        const cardBuf = this.entries().get('card.json');
        if (!cardBuf) throw new Error('Failed to extract card.json from CharX file');
        const card = JSON.parse(new TextDecoder().decode(cardBuf));
        if (card.spec === undefined) throw new Error('Invalid CharX card file: missing spec field');

        const embeddedAssets = this.collectCharXAssets(card);
        const iconAsset = this.pickCharXIconAsset(embeddedAssets);
        const auxiliaryAssets = this.mapCharXAssetsForStorage(embeddedAssets);

        const archivePaths = new Set<string>();
        if (iconAsset?.zipPath) archivePaths.add(iconAsset.zipPath);
        for (const a of auxiliaryAssets) if (a?.zipPath) archivePaths.add(a.zipPath);

        const extractedBuffers = new Map<string, Uint8Array>();
        for (const p of archivePaths) {
            const buf = this.entries().get(p);
            if (buf) extractedBuffers.set(p, buf);
        }

        const avatar = iconAsset?.zipPath ? (extractedBuffers.get(iconAsset.zipPath) ?? null) : null;
        return { card, avatar, auxiliaryAssets, extractedBuffers };
    }

    getEmbeddedZipPathFromUri(uri: unknown): string | null {
        if (typeof uri !== 'string') return null;
        const trimmed = uri.trim();
        if (!trimmed) return null;
        const lower = trimmed.toLowerCase();
        for (const prefix of CHARX_EMBEDDED_URI_PREFIXES) {
            if (lower.startsWith(prefix)) {
                return normalizeZipEntryPath(trimmed.slice(prefix.length));
            }
        }
        return null;
    }

    private normalizeExtString(ext: unknown): string {
        return typeof ext === 'string' ? ext.trim().toLowerCase().replace(/^\./, '') : '';
    }

    private stripTrailingImageExtension(name: string, expectedExt: string): string {
        if (!name || !expectedExt) return name;
        const lower = name.toLowerCase();
        if (lower.endsWith(`.${expectedExt}`)) return name.slice(0, -(expectedExt.length + 1));
        for (const ext of CHARX_IMAGE_EXTENSIONS) {
            if (lower.endsWith(`.${ext}`)) return name.slice(0, -(ext.length + 1));
        }
        return name;
    }

    private deriveCharXAssetExtension(assetExt: unknown, zipPath: string): string {
        const metaExt = this.normalizeExtString(assetExt);
        if (metaExt) return metaExt;
        const m = /\.([^.\\/]+)$/.exec(zipPath || '');
        return this.normalizeExtString(m?.[1]);
    }

    collectCharXAssets(card: Record<string, unknown>): CharXAsset[] {
        const assets = (card as { data?: { assets?: unknown[] } }).data?.assets;
        if (!Array.isArray(assets)) return [];
        return assets.map((asset, index) => {
            const a = asset as { uri?: string; ext?: string; type?: string; name?: string } | null;
            if (!a) return null;
            const zipPath = this.getEmbeddedZipPathFromUri(a.uri);
            if (!zipPath) return null;
            return {
                type: typeof a.type === 'string' ? a.type.toLowerCase() : '',
                name: typeof a.name === 'string' ? a.name : '',
                ext: this.deriveCharXAssetExtension(a.ext, zipPath),
                zipPath,
                order: index,
            };
        }).filter((x): x is CharXAsset => x !== null);
    }

    pickCharXIconAsset(assets: CharXAsset[]): CharXAsset | null {
        const icons = assets.filter(a => a.type === 'icon' && CHARX_IMAGE_EXTENSIONS.has(a.ext) && a.zipPath);
        if (!icons.length) return null;
        return icons.find(a => a.name?.toLowerCase() === 'main') ?? icons[0]!;
    }

    private getCharXAssetBaseName(name: string, fallback: string, useHyphens = false): string {
        const cleaned = String(name ?? '').trim();
        if (!cleaned) return fallback.toLowerCase();
        const sep = useHyphens ? '-' : '_';
        const base = cleaned.toLowerCase()
            .replace(/[^a-z0-9]+/g, sep)
            .replace(new RegExp(`^${sep}|${sep}$`, 'g'), '');
        if (!base) return fallback.toLowerCase();
        return (sanitizeFilename(base) || fallback).toLowerCase();
    }

    mapCharXAssetsForStorage(assets: CharXAsset[]): CharXAsset[] {
        return assets.reduce<CharXAsset[]>((acc, asset) => {
            if (!asset?.zipPath) return acc;
            const ext = (asset.ext || '').toLowerCase();
            if (!CHARX_IMAGE_EXTENSIONS.has(ext)) return acc;
            if (asset.type === 'icon' || asset.type === 'user_icon') return acc;

            const storageCategory: CharXAsset['storageCategory'] =
                CHARX_SPRITE_TYPES.has(asset.type) ? 'sprite'
                : CHARX_BACKGROUND_TYPES.has(asset.type) ? 'background'
                : 'misc';
            const useHyphens = storageCategory === 'sprite';
            const nameWithoutExt = this.stripTrailingImageExtension(asset.name, ext);
            acc.push({
                ...asset,
                ext,
                storageCategory,
                baseName: this.getCharXAssetBaseName(nameWithoutExt, `${storageCategory}-${asset.order ?? 0}`, useHyphens),
            });
            return acc;
        }, []);
    }
}
