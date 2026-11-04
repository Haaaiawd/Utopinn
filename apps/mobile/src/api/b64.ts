// Base64 → bytes → UTF-8 without atob/TextDecoder (Hermes ships neither
// reliably). The WS delivery layer sends upstream SSE bytes as base64
// strings; a UTF-8 sequence can split ACROSS frames, so decoding is done
// through createUtf8Decoder() which carries an incomplete trailing
// sequence into the next call — naive per-chunk decode would emit U+FFFD
// mojibake mid-stream for CJK content.

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = (() => {
    const t = new Int16Array(128).fill(-1);
    for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
    return t;
})();

export function b64ToBytes(b64: string): Uint8Array {
    // strip whitespace + padding tolerance
    const clean = b64.replace(/[\s=]/g, '');
    const len = clean.length;
    const out = new Uint8Array(Math.floor((len * 3) / 4) + 3);
    let o = 0;
    for (let i = 0; i < len; i += 4) {
        const a = B64_REV[clean.charCodeAt(i)];
        const b = i + 1 < len ? B64_REV[clean.charCodeAt(i + 1)] : -1;
        const c = i + 2 < len ? B64_REV[clean.charCodeAt(i + 2)] : -1;
        const d = i + 3 < len ? B64_REV[clean.charCodeAt(i + 3)] : -1;
        if (a < 0 || b < 0) break;
        out[o++] = (a << 2) | (b >> 4);
        if (c >= 0) {
            out[o++] = ((b & 15) << 4) | (c >> 2);
            if (d >= 0) out[o++] = ((c & 3) << 6) | d;
        }
    }
    return out.subarray(0, o);
}

/**
 * Incremental UTF-8 decoder: feed byte chunks, get back well-formed text.
 * A trailing incomplete multi-byte sequence is held until the next feed.
 */
export function createUtf8Decoder(): (bytes: Uint8Array) => string {
    let carry: Uint8Array = new Uint8Array(0);
    return (bytes: Uint8Array): string => {
        const buf = carry.length ? concat(carry, bytes) : bytes;
        let end = buf.length;
        // Walk back over a possibly incomplete trailing sequence: a lead
        // byte of width seqLen expects seqLen-1 continuation bytes after it.
        let found = 0;
        for (let i = buf.length - 1; i >= 0 && buf.length - i <= 4; i--) {
            const b = buf[i];
            if ((b & 0xc0) === 0x80) {
                found++;
                continue;
            }
            const seqLen = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
            if (seqLen - 1 > found) end = i; // lead byte missing continuations → carry
            break;
        }
        carry = buf.subarray(end);
        return decodeUtf8(buf.subarray(0, end));
    };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** One-shot UTF-8 decode of a well-formed buffer (replacement char on error). */
function decodeUtf8(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; ) {
        const b = bytes[i];
        if (b < 0x80) {
            out += String.fromCharCode(b);
            i += 1;
            continue;
        }
        const seqLen = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 0;
        if (!seqLen || i + seqLen > bytes.length) {
            out += '�';
            i += 1;
            continue;
        }
        let cp = b & (0x7f >> seqLen);
        let ok = true;
        for (let j = 1; j < seqLen; j++) {
            const cb = bytes[i + j];
            if ((cb & 0xc0) !== 0x80) {
                ok = false;
                break;
            }
            cp = (cp << 6) | (cb & 0x3f);
        }
        out += ok ? String.fromCodePoint(cp) : '�';
        i += ok ? seqLen : 1;
    }
    return out;
}
