// ============================================================
// Encoder APNG (PNG animato) e ZIP "store" - nessuna dipendenza
//
// APNG: trasparenza completa (255 livelli), colori pieni, nessuna
// palette: ombra e bagliori restano morbidi come sullo schermo.
// La compressione usa CompressionStream ('deflate' = zlib), presente
// in Chrome / Edge / Firefox / Safari recenti.
// ============================================================

const CRC_TABLE = (() => {

    const t = new Uint32Array(256);

    for (let n = 0; n < 256; n++) {

        let c = n;

        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);

        t[n] = c >>> 0;
    }

    return t;
})();

export function crc32(buf, crc = 0) {

    let c = ~crc >>> 0;

    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);

    return ~c >>> 0;
}

function u32(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type, data) {

    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);

    dv.setUint32(0, data.length);

    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);

    out.set(data, 8);

    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

    return out;
}

async function deflate(bytes) {

    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));

    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// righe PNG con filtro "Sub" (1): comprime molto meglio della versione senza filtro
function filterRows(rgba, width, height) {

    const stride = width * 4;
    const out = new Uint8Array((stride + 1) * height);

    for (let y = 0; y < height; y++) {

        const src = y * stride;
        const dst = y * (stride + 1);

        out[dst] = 1;

        for (let i = 0; i < stride; i++) {

            const left = i >= 4 ? rgba[src + i - 4] : 0;

            out[dst + 1 + i] = (rgba[src + i] - left) & 255;
        }
    }

    return out;
}

function concat(parts) {

    let n = 0;

    for (const p of parts) n += p.length;

    const out = new Uint8Array(n);

    let o = 0;

    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }

    return out;
}

/*
    frames: array di RGBA (Uint8ClampedArray) tutti width*height
    delays: centesimi di secondo per fotogramma
    loop: 0 = infinito
*/

export async function encodeAPNG(frames, width, height, { delays, loop = 0, onProgress } = {}) {

    if (!frames.length) throw new Error('Nessun frame da codificare.');

    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];

    parts.push(chunk('IHDR', new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0])));

    parts.push(chunk('acTL', new Uint8Array([...u32(frames.length), ...u32(loop)])));

    let seq = 0;

    for (let f = 0; f < frames.length; f++) {

        const cs = Math.max(1, Math.round((delays && delays[f]) || 4));

        // x 10 ms: den = 1000
        parts.push(chunk('fcTL', new Uint8Array([
            ...u32(seq++),
            ...u32(width), ...u32(height),
            ...u32(0), ...u32(0),
            (cs * 10) >> 8, (cs * 10) & 255,
            1000 >> 8, 1000 & 255,
            0,      // dispose: nessuna
            0       // blend: SOURCE (sostituisce anche i pixel trasparenti)
        ])));

        const z = await deflate(filterRows(frames[f], width, height));

        if (f === 0) {

            parts.push(chunk('IDAT', z));

        } else {

            parts.push(chunk('fdAT', concat([new Uint8Array(u32(seq++)), z])));
        }

        if (onProgress) await onProgress(f + 1, frames.length);
    }

    parts.push(chunk('IEND', new Uint8Array(0)));

    return concat(parts);
}


// ------------------------------------------------------------
// ZIP senza compressione (i PNG sono gia' compressi)
// files: [{ name, data: Uint8Array }]
// ------------------------------------------------------------

export function encodeZip(files) {

    const enc = new TextEncoder();

    const local = [];
    const central = [];

    let offset = 0;

    for (const f of files) {

        const name = enc.encode(f.name);
        const crc = crc32(f.data);

        const h = new Uint8Array(30 + name.length);
        const dv = new DataView(h.buffer);

        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0x0800, true);          // nomi UTF-8
        dv.setUint16(8, 0, true);               // store
        dv.setUint16(10, 0, true);
        dv.setUint16(12, 0x21, true);           // data 1980-01-01
        dv.setUint32(14, crc, true);
        dv.setUint32(18, f.data.length, true);
        dv.setUint32(22, f.data.length, true);
        dv.setUint16(26, name.length, true);
        dv.setUint16(28, 0, true);

        h.set(name, 30);

        local.push(h, f.data);

        const c = new Uint8Array(46 + name.length);
        const cv = new DataView(c.buffer);

        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0x21, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, f.data.length, true);
        cv.setUint32(24, f.data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);

        c.set(name, 46);

        central.push(c);

        offset += h.length + f.data.length;
    }

    const centralBytes = concat(central);

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);

    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralBytes.length, true);
    ev.setUint32(16, offset, true);

    return concat([...local, centralBytes, end]);
}


// ============================================================
// VERSIONI A FLUSSO (un fotogramma alla volta)
//
// Ogni fotogramma viene compresso appena arriva e si tiene solo il
// risultato compresso (dentro un Blob, che il browser puo' anche
// spostare su disco). La memoria non cresce con la lunghezza.
// ============================================================

export function createAPNGWriter(width, height, numFrames, { loop = 0 } = {}) {

    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0])),
        chunk('acTL', new Uint8Array([...u32(numFrames), ...u32(loop)]))
    ];

    let seq = 0;
    let f = 0;

    async function addFrame(rgba, delayCs) {

        if (f >= numFrames) throw new Error('APNG: troppi fotogrammi');

        const cs = Math.max(1, Math.round(delayCs || 4));

        const ctl = chunk('fcTL', new Uint8Array([
            ...u32(seq++),
            ...u32(width), ...u32(height),
            ...u32(0), ...u32(0),
            (cs * 10) >> 8, (cs * 10) & 255,
            1000 >> 8, 1000 & 255,
            0,      // dispose: nessuna
            0       // blend: SOURCE
        ]));

        const z = await deflate(filterRows(rgba, width, height));

        const data = f === 0
            ? chunk('IDAT', z)
            : chunk('fdAT', concat([new Uint8Array(u32(seq++)), z]));

        parts.push(new Blob([ctl, data]));

        f++;
    }

    function finish() {
        if (f !== numFrames) throw new Error(`APNG: attesi ${numFrames} fotogrammi, arrivati ${f}`);
        parts.push(chunk('IEND', new Uint8Array(0)));
        return new Blob(parts, { type: 'image/png' });
    }

    return { addFrame, finish };
}


export function createZipWriter() {

    const enc = new TextEncoder();
    const parts = [];
    const central = [];

    let offset = 0;
    let count = 0;

    function addFile(fileName, data) {

        const name = enc.encode(fileName);
        const crc = crc32(data);

        const h = new Uint8Array(30 + name.length);
        const dv = new DataView(h.buffer);

        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0x0800, true);
        dv.setUint16(8, 0, true);
        dv.setUint16(10, 0, true);
        dv.setUint16(12, 0x21, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, data.length, true);
        dv.setUint32(22, data.length, true);
        dv.setUint16(26, name.length, true);
        dv.setUint16(28, 0, true);
        h.set(name, 30);

        parts.push(new Blob([h, data]));

        const c = new Uint8Array(46 + name.length);
        const cv = new DataView(c.buffer);

        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0x21, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        c.set(name, 46);

        central.push(c);

        offset += h.length + data.length;
        count++;
    }

    function finish() {

        const centralBytes = concat(central);

        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);

        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, count, true);
        ev.setUint16(10, count, true);
        ev.setUint32(12, centralBytes.length, true);
        ev.setUint32(16, offset, true);

        return new Blob([...parts, centralBytes, end], { type: 'application/zip' });
    }

    return { addFile, finish };
}