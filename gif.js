// ============================================================
// Encoder GIF89a minimale (nessuna dipendenza)
//
// - UNA SOLA palette globale per tutti i frame (niente sfarfallio di
//   colori tra un fotogramma e l'altro, che si vedrebbe come "scatto")
// - trasparenza a 1 bit (opzionale), loop infinito
// - nessun dithering (il rumore cambierebbe da un frame all'altro)
// ============================================================

class ByteWriter {

    constructor() {
        this.buf = new Uint8Array(1 << 16);
        this.len = 0;
    }

    ensure(extra) {
        if (this.len + extra <= this.buf.length) return;
        let size = this.buf.length;
        while (size < this.len + extra) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }

    byte(b) {
        this.ensure(1);
        this.buf[this.len++] = b & 255;
    }

    word(w) {
        this.byte(w & 255);
        this.byte((w >> 8) & 255);
    }

    bytes(arr) {
        this.ensure(arr.length);
        this.buf.set(arr, this.len);
        this.len += arr.length;
    }

    ascii(s) {
        for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
    }

    result() {
        return this.buf.slice(0, this.len);
    }
}


// ------------------------------------------------------------
// LZW (codici a lunghezza variabile, come da specifica GIF)
// ------------------------------------------------------------

function lzwEncode(indices, minCodeSize) {

    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;

    const out = [];
    let cur = 0;
    let bits = 0;

    const emit = (code) => {

        cur |= code << bits;
        bits += codeSize;

        while (bits >= 8) {
            out.push(cur & 255);
            cur >>>= 8;
            bits -= 8;
        }
    };

    let table = new Map();

    emit(clearCode);

    let prefix = indices[0];

    for (let i = 1; i < indices.length; i++) {

        const k = indices[i];
        const key = (prefix << 8) | k;
        const found = table.get(key);

        if (found !== undefined) {

            prefix = found;
            continue;
        }

        emit(prefix);

        if (nextCode === 4096) {

            emit(clearCode);
            table = new Map();
            codeSize = minCodeSize + 1;
            nextCode = eoiCode + 1;

        } else {

            if (nextCode >= (1 << codeSize)) codeSize++;

            table.set(key, nextCode++);
        }

        prefix = k;
    }

    emit(prefix);
    emit(eoiCode);

    if (bits > 0) out.push(cur & 255);

    return out;
}


// ------------------------------------------------------------
// Palette (median cut su istogramma a 5 bit per canale)
//
// Si costruisce UN FOTOGRAMMA ALLA VOLTA: add(rgba) accumula solo
// l'istogramma (32768 caselle, pochi KB), poi i pixel si possono
// buttare. Cosi' la memoria non cresce con la lunghezza.
// ------------------------------------------------------------

export function createPaletteBuilder() {

    const count = new Float64Array(32768);
    const sumR = new Float64Array(32768);
    const sumG = new Float64Array(32768);
    const sumB = new Float64Array(32768);

    function add(data) {

        for (let p = 0; p < data.length; p += 4) {

            if (data[p + 3] < 128) continue;

            const r = data[p];
            const g = data[p + 1];
            const b = data[p + 2];

            const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

            count[key]++;
            sumR[key] += r;
            sumG[key] += g;
            sumB[key] += b;
        }
    }

    function finish(transparent) {

        const keys = [];

        for (let k = 0; k < 32768; k++) {
            if (count[k] > 0) keys.push(k);
        }

        const maxColors = transparent ? 255 : 256;

        const total = (list) => {
            let t = 0;
            for (const k of list) t += count[k];
            return t;
        };

        const ranges = (list) => {

            let r0 = 31, r1 = 0, g0 = 31, g1 = 0, b0 = 31, b1 = 0;

            for (const k of list) {

                const r = k >> 10, g = (k >> 5) & 31, b = k & 31;

                if (r < r0) r0 = r; if (r > r1) r1 = r;
                if (g < g0) g0 = g; if (g > g1) g1 = g;
                if (b < b0) b0 = b; if (b > b1) b1 = b;
            }

            return [r1 - r0, g1 - g0, b1 - b0];
        };

        let boxes = keys.length ? [keys] : [];

        while (boxes.length < maxColors) {

            // scelgo la scatola con piu' pixel e piu' ampia
            let pick = -1, best = -1, pickRanges = null;

            for (let i = 0; i < boxes.length; i++) {

                if (boxes[i].length < 2) continue;

                const rg = ranges(boxes[i]);
                const score = total(boxes[i]) * (1 + Math.max(rg[0], rg[1], rg[2]));

                if (score > best) {
                    best = score;
                    pick = i;
                    pickRanges = rg;
                }
            }

            if (pick < 0) break;

            const box = boxes[pick];

            const ch = pickRanges[0] >= pickRanges[1] && pickRanges[0] >= pickRanges[2]
                ? 0
                : (pickRanges[1] >= pickRanges[2] ? 1 : 2);

            const val = (k) => ch === 0 ? (k >> 10) : (ch === 1 ? ((k >> 5) & 31) : (k & 31));

            box.sort((a, b) => val(a) - val(b));

            const half = total(box) / 2;

            let acc = 0, cut = 1;

            for (let i = 0; i < box.length - 1; i++) {

                acc += count[box[i]];
                cut = i + 1;

                if (acc >= half) break;
            }

            boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
        }

        const offset = transparent ? 1 : 0;

        const palette = new Uint8Array(256 * 3);
        const lut = new Uint8Array(32768);

        boxes.forEach((box, i) => {

            let n = 0, r = 0, g = 0, b = 0;

            for (const k of box) {

                n += count[k];
                r += sumR[k];
                g += sumG[k];
                b += sumB[k];

                lut[k] = i + offset;
            }

            palette[(i + offset) * 3] = Math.round(r / n);
            palette[(i + offset) * 3 + 1] = Math.round(g / n);
            palette[(i + offset) * 3 + 2] = Math.round(b / n);
        });

        // colori mai visti nei fotogrammi analizzati (es. un lampo in
        // un fotogramma non campionato): il colore piu' vicino della palette
        const nColors = boxes.length;

        if (nColors) {

            for (let k = 0; k < 32768; k++) {

                if (count[k] > 0) continue;

                const r = ((k >> 10) << 3) + 4, g = (((k >> 5) & 31) << 3) + 4, b = ((k & 31) << 3) + 4;

                let best = 0, bestD = Infinity;

                for (let i = 0; i < nColors; i++) {

                    const o = (i + offset) * 3;
                    const dr = palette[o] - r, dg = palette[o + 1] - g, db = palette[o + 2] - b;
                    const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;

                    if (d < bestD) { bestD = d; best = i; }
                }

                lut[k] = best + offset;
            }
        }

        return { palette, lut };
    }

    return { add, finish };
}


// ------------------------------------------------------------
// SCRITTURA A FLUSSO
//
// addFrame(rgba, delay) codifica subito il fotogramma e tiene solo i
// byte compressi (in un Blob: il browser puo' anche parcheggiarli su
// disco). finish() restituisce il file finale come Blob.
// ------------------------------------------------------------

export function createGifWriter(width, height, { palette, lut, transparent = false, loop = 0 }) {

    const parts = [];

    const head = new ByteWriter();

    head.ascii('GIF89a');
    head.word(width);
    head.word(height);
    head.byte(0xF7);              // tabella globale, 256 colori
    head.byte(0);                 // colore di sfondo
    head.byte(0);                 // aspect ratio
    head.bytes(palette);

    // loop infinito
    head.byte(0x21); head.byte(0xFF); head.byte(11);
    head.ascii('NETSCAPE2.0');
    head.byte(3); head.byte(1); head.word(loop); head.byte(0);

    parts.push(head.result());

    const indices = new Uint8Array(width * height);

    function addFrame(data, delay = 4) {

        for (let p = 0, i = 0; p < data.length; p += 4, i++) {

            indices[i] = data[p + 3] < 128
                ? 0
                : lut[((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)];
        }

        const w = new ByteWriter();

        // Graphic Control Extension
        w.byte(0x21); w.byte(0xF9); w.byte(4);
        w.byte((transparent ? 2 : 1) << 2 | (transparent ? 1 : 0));   // disposal: 2 = ripristina sfondo, 1 = lascia
        w.word(Math.max(2, delay || 4));
        w.byte(0);                                                      // indice trasparente
        w.byte(0);

        // Image Descriptor
        w.byte(0x2C);
        w.word(0); w.word(0);
        w.word(width); w.word(height);
        w.byte(0);

        w.byte(8);                                                      // min code size

        const lzw = lzwEncode(indices, 8);

        for (let i = 0; i < lzw.length; i += 255) {

            const chunk = lzw.slice(i, i + 255);

            w.byte(chunk.length);
            w.bytes(chunk);
        }

        w.byte(0);

        parts.push(new Blob([w.result()]));
    }

    function finish() {
        parts.push(new Uint8Array([0x3B]));
        return new Blob(parts, { type: 'image/gif' });
    }

    return { addFrame, finish };
}


// ------------------------------------------------------------
// API vecchia (tutti i frame in memoria): resta per compatibilita'
// frames: array di Uint8ClampedArray RGBA (tutti width*height)
// delays: centesimi di secondo per ogni frame
// ------------------------------------------------------------

export async function encodeGIF(frames, width, height, options = {}) {

    const transparent = !!options.transparent;
    const delays = options.delays || frames.map(() => 4);

    if (!frames.length) throw new Error('Nessun frame da codificare.');

    const pb = createPaletteBuilder();
    frames.forEach(f => pb.add(f));

    const gw = createGifWriter(width, height, { ...pb.finish(transparent), transparent, loop: options.loop || 0 });
    frames.forEach((f, i) => gw.addFrame(f, delays[i]));

    return new Uint8Array(await gw.finish().arrayBuffer());
}