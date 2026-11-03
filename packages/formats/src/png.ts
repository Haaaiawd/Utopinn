// png.ts — PNG chunk 读写 + 角色卡元数据(chara/ccv3 tEXt|zTXt|iTXt)。
// 移植自 apps/server/src/character-card-parser.js + png/encode.js。
// 纯 Uint8Array,无 Node Buffer——server/RN/浏览器通用。
import { unzlibSync, zlibSync } from 'fflate';
import { crc32 } from './crc32.js';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const te = new TextEncoder();
const tdLatin = new TextDecoder('latin1');
const tdUtf8 = new TextDecoder('utf-8');

export interface PngChunk {
    name: string;
    data: Uint8Array;
}

export function isPng(buf: Uint8Array): boolean {
    return buf.length >= 8 && PNG_SIG.every((b, i) => buf[i] === b);
}

/** 遍历 PNG chunk(IHDR..IEND),不做 CRC 校验(与原实现一致)。 */
export function parsePngChunks(buf: Uint8Array): PngChunk[] {
    if (!isPng(buf)) throw new Error('not a PNG');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const chunks: PngChunk[] = [];
    let off = 8;
    while (off + 12 <= buf.length) {
        const len = dv.getUint32(off);
        const name = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!);
        chunks.push({ name, data: buf.slice(off + 8, off + 8 + len) });
        off += 12 + len;
        if (name === 'IEND') break;
    }
    return chunks;
}

export function encodePngChunks(chunks: PngChunk[]): Uint8Array {
    let total = 8;
    for (const c of chunks) total += c.data.length + 12;
    const out = new Uint8Array(total);
    out.set(PNG_SIG, 0);
    const dv = new DataView(out.buffer);
    let idx = 8;
    for (const c of chunks) {
        dv.setUint32(idx, c.data.length);
        idx += 4;
        const nameBytes = te.encode(c.name.slice(0, 4).padEnd(4, ' '));
        out.set(nameBytes.slice(0, 4), idx);
        idx += 4;
        out.set(c.data, idx);
        idx += c.data.length;
        // CRC 覆盖 type+data
        const crcBuf = new Uint8Array(4 + c.data.length);
        crcBuf.set(nameBytes.slice(0, 4), 0);
        crcBuf.set(c.data, 4);
        dv.setUint32(idx, crc32(crcBuf));
        idx += 4;
    }
    return out;
}

/** tEXt payload = keyword\0 + latin1 text */
export function decodeTextChunk(data: Uint8Array): { keyword: string; text: string } {
    const sep = data.indexOf(0);
    if (sep < 0) throw new Error('Invalid tEXt chunk: missing keyword separator');
    if (data.indexOf(0, sep + 1) >= 0) {
        throw new Error('Invalid NULL character found. 0x00 character is not permitted in tEXt content');
    }
    return {
        keyword: tdLatin.decode(data.subarray(0, sep)),
        text: tdLatin.decode(data.subarray(sep + 1)),
    };
}

function readTextChunkKeyword(data: Uint8Array): string {
    const sep = data.indexOf(0);
    return sep < 0 ? '' : tdLatin.decode(data.subarray(0, sep));
}

/** zTXt payload = keyword\0 + method(1B) + zlib(text) */
export function decodeZtxtChunk(data: Uint8Array): { keyword: string; text: string } {
    const sep = data.indexOf(0);
    if (sep < 0) throw new Error('Invalid zTXt chunk: missing keyword separator');
    const method = data[sep + 1];
    if (method !== 0) throw new Error(`Unsupported zTXt compression method: ${method}`);
    return {
        keyword: tdLatin.decode(data.subarray(0, sep)),
        text: tdUtf8.decode(unzlibSync(data.subarray(sep + 2))),
    };
}

/** iTXt payload = keyword\0 + flag\0 + method\0 + lang\0 + trans\0 + (zlib?)text */
export function decodeItxtChunk(data: Uint8Array): { keyword: string; text: string } {
    const sep = data.indexOf(0);
    if (sep < 0) throw new Error('Invalid iTXt chunk: missing keyword separator');
    const keyword = tdLatin.decode(data.subarray(0, sep));
    const flag = data[sep + 1] ?? 0;
    const method = data[sep + 2] ?? 0;
    let off = sep + 3;
    const langEnd = data.indexOf(0, off);
    off = (langEnd < 0 ? off : langEnd) + 1;
    const transEnd = data.indexOf(0, off);
    off = (transEnd < 0 ? off : transEnd) + 1;
    let text = data.subarray(off);
    if (flag === 1 && method === 0) text = unzlibSync(text);
    return { keyword, text: tdUtf8.decode(text) };
}

export function encodeTextChunk(keyword: string, text: string): PngChunk {
    const kw = te.encode(keyword);
    const tx = te.encode(text); // UTF-8;tEXt 规范是 latin1,但 base64 payload 纯 ASCII 无歧义
    const data = new Uint8Array(kw.length + 1 + tx.length);
    data.set(kw, 0);
    data[kw.length] = 0;
    data.set(tx, kw.length + 1);
    return { name: 'tEXt', data };
}

// ---------- base64(无 Buffer 环境) ----------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function u8ToBase64(u8: Uint8Array): string {
    let out = '';
    for (let i = 0; i < u8.length; i += 3) {
        const a = u8[i]!, b = u8[i + 1], c = u8[i + 2];
        out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
        out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
        out += c === undefined ? '=' : B64[c & 63]!;
    }
    return out;
}
const b64rev = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) b64rev[B64.charCodeAt(i)] = i;
export function base64ToU8(s: string): Uint8Array {
    const clean = s.replace(/[\s=]+$/, '').replace(/=+$/, '');
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const a = b64rev[clean.charCodeAt(i)] ?? 0;
        const b = b64rev[clean.charCodeAt(i + 1)] ?? 0;
        const c = b64rev[clean.charCodeAt(i + 2)] ?? 0;
        const d = b64rev[clean.charCodeAt(i + 3)] ?? 0;
        if (o < out.length) out[o++] = (a << 2) | (b >> 4);
        if (o < out.length) out[o++] = ((b & 15) << 4) | (c >> 2);
        if (o < out.length) out[o++] = ((c & 3) << 6) | d;
    }
    return out.subarray(0, o);
}

/**
 * 读卡:ccv3 > chara;支持 tEXt/zTXt/iTXt 三种载体。
 * 与原实现一致:tEXt 内为 base64(JSON)。
 */
export function readCardFromPng(image: Uint8Array): string {
    const chunks = parsePngChunks(image);
    const textChunks = chunks.filter(c => c.name === 'tEXt' || c.name === 'zTXt' || c.name === 'iTXt');
    if (textChunks.length === 0) throw new Error('No PNG metadata.');

    const findByKeyword = (kw: string): { keyword: string; text: string } | undefined => {
        for (const c of textChunks) {
            try {
                const decoded = c.name === 'tEXt' ? decodeTextChunk(c.data)
                    : c.name === 'zTXt' ? decodeZtxtChunk(c.data)
                    : decodeItxtChunk(c.data);
                if (decoded.keyword.toLowerCase() === kw) return decoded;
            } catch { /* 跳过坏块 */ }
        }
        return undefined;
    };

    const chunk = findByKeyword('ccv3') ?? findByKeyword('chara');
    if (!chunk) throw new Error('No PNG metadata.');
    return tdUtf8.decode(base64ToU8(chunk.text));
}

/**
 * 写卡:删除既有 chara/ccv3 tEXt,插 chara(v2 原样)+ ccv3(spec 改 v3)于 IEND 前。
 * 行为对齐原 write():ccv3 写入失败静默忽略。
 */
export function writeCardToPng(image: Uint8Array, cardJson: string): Uint8Array {
    const chunks = parsePngChunks(image).filter(c => {
        if (c.name !== 'tEXt') return true;
        const kw = readTextChunkKeyword(c.data).toLowerCase();
        return kw !== 'chara' && kw !== 'ccv3';
    });
    if (chunks[chunks.length - 1]?.name !== 'IEND') throw new Error('PNG missing IEND');
    const iend = chunks.pop()!;

    chunks.push(encodeTextChunk('chara', u8ToBase64(te.encode(cardJson))));
    try {
        const v3 = JSON.parse(cardJson);
        v3.spec = 'chara_card_v3';
        v3.spec_version = '3.0';
        chunks.push(encodeTextChunk('ccv3', u8ToBase64(te.encode(JSON.stringify(v3)))));
    } catch { /* 非 JSON 输入时跳过 v3,与原实现一致 */ }
    chunks.push(iend);
    return encodePngChunks(chunks);
}

/** 复制 PNG 但剥掉 chara/ccv3 元数据(展示衍生图不携带卡面)。 */
export function stripPngCardMetadata(image: Uint8Array): Uint8Array {
    const chunks = parsePngChunks(image).filter(c => {
        if (c.name !== 'tEXt') return true;
        const kw = readTextChunkKeyword(c.data).toLowerCase();
        return kw !== 'chara' && kw !== 'ccv3';
    });
    return encodePngChunks(chunks);
}

// zTXt 编码留给需要的调用方(导出 zlibSync 用法)
export { zlibSync };
