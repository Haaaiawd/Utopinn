/**
 * Portable base64 — no `Buffer`, no `atob`/`btoa` requirement.
 * Runs in browsers, RN/Hermes and Node (uses Buffer when present as a fast path).
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_REVERSE: Record<string, number> = (() => {
    const t: Record<string, number> = {};
    for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET[i]!] = i;
    return t;
})();

type BufferLike = { from(data: Uint8Array | string, enc?: string): { toString(enc?: string): string; byteLength?: number } };

function nodeBuffer(): BufferLike | undefined {
    return (globalThis as { Buffer?: BufferLike }).Buffer;
}

/** base64 → bytes. Whitespace-tolerant; stops at '=' padding. */
export function decodeBase64Bytes(b64: string): Uint8Array {
    const clean = String(b64).replace(/[\r\n\t ]/g, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0, acc = 0, bits = 0;
    for (const ch of clean) {
        if (ch === '=') break;
        const v = B64_REVERSE[ch];
        if (v === undefined) continue;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (acc >> bits) & 0xff;
        }
    }
    return out.subarray(0, o);
}

/** base64 → utf-8 text (WS chunk frames are base64-encoded upstream SSE bytes). */
export function decodeBase64Utf8(b64: string): string {
    const B = nodeBuffer();
    if (B?.from) return B.from(b64, 'base64').toString('utf8');
    return new TextDecoder().decode(decodeBase64Bytes(b64));
}

/** bytes → base64. */
export function encodeBase64Bytes(bytes: Uint8Array): string {
    const B = nodeBuffer();
    if (B?.from) return B.from(bytes).toString('base64');
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i] ?? 0;
        const hasB = i + 1 < bytes.length;
        const hasC = i + 2 < bytes.length;
        const b = bytes[i + 1] ?? 0;
        const c = bytes[i + 2] ?? 0;
        out += B64_ALPHABET.charAt(a >> 2)
            + B64_ALPHABET.charAt(((a & 3) << 4) | (b >> 4))
            + (hasB ? B64_ALPHABET.charAt(((b & 15) << 2) | (c >> 6)) : '=')
            + (hasC ? B64_ALPHABET.charAt(c & 63) : '=');
    }
    return out;
}

/**
 * Import payload helper — accepts bytes or a Blob (browser/RN) and yields
 * the `{name, dataBase64}` body the /import endpoints consume.
 */
export async function toBase64Payload(
    name: string,
    data: Uint8Array | ArrayBuffer | Blob,
): Promise<{ name: string; dataBase64: string }> {
    let bytes: Uint8Array;
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        bytes = new Uint8Array(await data.arrayBuffer());
    } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
    } else {
        bytes = data as Uint8Array;
    }
    return { name, dataBase64: encodeBase64Bytes(bytes) };
}
