// byaf.ts — Backyard Archive Format(zip)解析,移植 apps/server/src/byaf.js。
// 纯解析:manifest.json → 角色/场景/图片/聊天背景。落盘与默认头像交给调用方。
import { unzipFile } from './zip.js';

export interface ByafImage { filename: string; image: Uint8Array | null; label: string }
export interface ByafChatBackground { name: string; data: Uint8Array; paths: string[] }

export interface ByafParseResult {
    card: Record<string, unknown>;
    images: ByafImage[];
    scenarios: Record<string, unknown>[];
    chatBackgrounds: ByafChatBackground[];
    character: Record<string, unknown>;
}

const td = new TextDecoder();
const json = (buf: Uint8Array) => JSON.parse(td.decode(buf));
const zipPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/^\//, '');
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);
const joinPath = (dir: string, rel: string) => zipPath(dir ? `${dir}/${rel}` : rel);
const u8eq = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

export class ByafParser {
    private data: Uint8Array | ArrayBuffer;

    constructor(data: Uint8Array | ArrayBuffer) {
        this.data = data;
    }

    static replaceMacros(str?: string): string {
        return String(str || '')
            .replace(/#{user}:/gi, '{{user}}:')
            .replace(/#{character}:/gi, '{{char}}:')
            .replace(/{character}(?!})/gi, '{{char}}')
            .replace(/{user}(?!})/gi, '{{user}}');
    }

    static formatExampleMessages(examples?: { text?: string }[]): string {
        if (!Array.isArray(examples)) return '';
        let out = '';
        for (const example of examples) {
            if (!example?.text) continue;
            out += `<START>\n${ByafParser.replaceMacros(example.text)}\n`;
        }
        return out.trimEnd();
    }

    private get(path: string): Uint8Array | null {
        return unzipFile(this.data instanceof Uint8Array ? this.data : new Uint8Array(this.data), path);
    }

    private formatAlternateGreetings(scenarios: Record<string, any>[]): string[] {
        if (!Array.isArray(scenarios) || scenarios.length <= 1) return [];
        const greetings = new Set<string>();
        const firstScenarioFirstMessage = scenarios[0]?.firstMessages?.[0]?.text;
        for (const scenario of scenarios.slice(1).filter(s => Array.isArray(s.firstMessages) && s.firstMessages.length > 0)) {
            const firstMessage = scenario?.firstMessages?.[0];
            if (firstMessage?.text && firstMessage.text !== firstScenarioFirstMessage) {
                greetings.add(ByafParser.replaceMacros(firstMessage.text));
            }
        }
        return [...greetings];
    }

    private convertCharacterBook(items?: { key?: string; value?: string }[]) {
        if (!Array.isArray(items) || items.length === 0) return undefined;
        const entries = items.filter(Boolean).map((item, index) => ({
            keys: ByafParser.replaceMacros(item?.key).split(',').map(k => k.trim()).filter(Boolean),
            content: ByafParser.replaceMacros(item?.value),
            extensions: {},
            enabled: true,
            insertion_order: index,
        }));
        return { entries, extensions: {} };
    }

    private getManifest(): Record<string, any> {
        const buf = this.get('manifest.json');
        if (!buf) throw new Error('Failed to extract manifest.json from BYAF file');
        const manifest = json(buf);
        if (!manifest || typeof manifest !== 'object') throw new Error('Invalid BYAF manifest');
        return manifest;
    }

    private getCharacterFromManifest(manifest: Record<string, any>) {
        const arr = manifest?.characters;
        if (!Array.isArray(arr)) throw new Error('Invalid BYAF file: missing characters array');
        if (arr.length === 0) throw new Error('Invalid BYAF file: characters array is empty');
        const characterPath = arr[0];
        if (!characterPath) throw new Error('Invalid BYAF file: missing character path');
        const buf = this.get(characterPath);
        if (!buf) throw new Error('Invalid BYAF file: failed to extract character JSON');
        try {
            return { character: json(buf), characterPath };
        } catch {
            throw new Error('Invalid BYAF file: character is not a valid JSON');
        }
    }

    private getScenariosFromManifest(manifest: Record<string, any>): Record<string, any>[] {
        const arr = manifest?.scenarios;
        if (!Array.isArray(arr) || arr.length === 0) return [{}];
        const scenarios: Record<string, any>[] = [];
        for (const p of arr) {
            const buf = this.get(p);
            if (!buf) continue;
            try { scenarios.push(json(buf)); } catch { /* 坏场景跳过 */ }
        }
        return scenarios.length ? scenarios : [{}];
    }

    private getCharacterImages(character: Record<string, any>, characterPath: string): ByafImage[] {
        const images = character?.images;
        if (!Array.isArray(images) || images.length === 0) {
            return [{ filename: '', image: null, label: '' }];
        }
        const out: ByafImage[] = [];
        for (const image of images) {
            const imagePath = image?.path;
            if (!imagePath) continue;
            const buf = this.get(joinPath(dirOf(characterPath), imagePath));
            if (!buf) continue;
            out.push({ filename: baseOf(imagePath), image: buf, label: image?.label || '' });
        }
        return out.length ? out : [{ filename: '', image: null, label: '' }];
    }

    private getCharacterCard(manifest: Record<string, any>, character: Record<string, any>, scenarios: Record<string, any>[]) {
        return {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: character?.name || character?.displayName || '',
                description: ByafParser.replaceMacros(character?.persona),
                personality: '',
                scenario: ByafParser.replaceMacros(scenarios[0]?.narrative),
                first_mes: ByafParser.replaceMacros(scenarios[0]?.firstMessages?.[0]?.text),
                mes_example: ByafParser.formatExampleMessages(scenarios[0]?.exampleMessages),
                creator_notes: manifest?.author?.backyardURL || '',
                system_prompt: ByafParser.replaceMacros(scenarios[0]?.formattingInstructions),
                post_history_instructions: '',
                alternate_greetings: this.formatAlternateGreetings(scenarios),
                character_book: this.convertCharacterBook(character?.loreItems),
                tags: character?.isNSFW ? ['nsfw'] : [],
                creator: manifest?.author?.name || '',
                character_version: '',
                extensions: { ...(character?.displayName && { display_name: character?.displayName }) },
            },
            create_date: new Date().toISOString(),
        };
    }

    private getChatBackgrounds(character: Record<string, any>, scenarios: Record<string, any>[]): ByafChatBackground[] {
        const backgrounds: ByafChatBackground[] = [];
        let i = 1;
        for (const scenario of scenarios) {
            const bgImagePath = scenario?.backgroundImage;
            if (!bgImagePath) continue;
            const data = this.get(bgImagePath);
            if (!data) continue;
            const existing = backgrounds.find(bg => u8eq(bg.data, data));
            if (existing) {
                existing.paths.push(bgImagePath);
                continue;
            }
            backgrounds.push({
                name: `${character?.name} bg ${i++}` || '',
                data,
                paths: [bgImagePath],
            });
        }
        return backgrounds;
    }

    parse(): ByafParseResult {
        const manifest = this.getManifest();
        const { character, characterPath } = this.getCharacterFromManifest(manifest);
        const scenarios = this.getScenariosFromManifest(manifest);
        const images = this.getCharacterImages(character, characterPath);
        const card = this.getCharacterCard(manifest, character, scenarios);
        const chatBackgrounds = this.getChatBackgrounds(character, scenarios);
        return { card, images, scenarios, chatBackgrounds, character };
    }
}
