// crc32.ts — 标准 CRC-32(PNG chunk 校验用),表驱动。
let table: Uint32Array | null = null;

function getTable(): Uint32Array {
    if (table) return table;
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
}

export function crc32(data: Uint8Array, crc = 0): number {
    const t = getTable();
    let c = crc ^ 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}
