// ============================================================
// Encoder GIF89a minimale (nessuna dipendenza)
//
// - UNA SOLA palette globale per tutti i frame (niente sfarfallio di
//   colori tra un fotogramma e l'altro, che si vedrebbe come "scatto")
// - trasparenza a 1 bit (indice 0 della palette), loop infinito
// - fotogrammi ridotti al rettangolo che cambia (riproduzione leggera)
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
//
// LEGGERA DA RIPRODURRE: i browser, a ogni fotogramma, decodificano
// l'immagine e la rimettono insieme al fotogramma precedente. Se ogni
// fotogramma e' grande quanto tutta l'area (es. 3594x1858 pixel con il
// personaggio alto 120) la riproduzione rallenta e scatta. Quindi ogni
// fotogramma contiene solo il RETTANGOLO che cambia davvero:
//
// - se nessun pixel torna da "pieno" a "trasparente", il fotogramma
//   contiene solo i pixel cambiati (gli altri sono "trasparenti" =
//   lascia quello che c'e'), con smaltimento 1 (non cancellare);
// - altrimenti il fotogramma precedente viene cancellato (smaltimento 2)
//   e il nuovo contiene tutti i suoi pixel non trasparenti;
// - un fotogramma identico al precedente non viene scritto: si allunga
//   la durata di quello prima (es. animazioni "a scatti" a 12 fps);
//
// Il risultato a schermo e' IDENTICO, ma il file e il lavoro del browser
// diventano molto piu' piccoli. L'indice 0 della palette e' sempre
// "trasparente" (la palette ha quindi al massimo 255 colori).
// ------------------------------------------------------------

export function createGifWriter(width, height, { palette, lut, loop = 0 }) {

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

    const total = width * height;

    let prev = null;               // indici (0 = trasparente) di cio' che si vede dopo l'ultimo fotogramma
    let cur = new Uint8Array(total);
    let pending = null;            // ultimo fotogramma, ancora da scrivere (potrebbe allungarsi o cambiare smaltimento)

    // rettangolo che contiene i pixel per cui test(i) e' vero
    function bounds(test) {

        let x0 = width, y0 = height, x1 = -1, y1 = -1;

        for (let y = 0, i = 0; y < height; y++) {

            let rowHit = false;

            for (let x = 0; x < width; x++, i++) {

                if (test(i)) {

                    rowHit = true;

                    if (x < x0) x0 = x;
                    if (x > x1) x1 = x;
                }
            }

            if (rowHit) {
                if (y < y0) y0 = y;
                y1 = y;
            }
        }

        return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }

    // pixel di un rettangolo; con "base" i pixel uguali a base restano 0 (= lascia com'e')
    function cut(src, r, base) {

        const out = new Uint8Array(r.w * r.h);

        for (let y = 0, o = 0; y < r.h; y++) {

            let i = (r.y + y) * width + r.x;

            for (let x = 0; x < r.w; x++, i++, o++) {
                out[o] = base && base[i] === src[i] ? 0 : src[i];
            }
        }

        return out;
    }

    const union = (a, b) => {

        if (!a) return b;
        if (!b) return a;

        const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
        const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);

        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };

    const EMPTY = { x: 0, y: 0, w: 1, h: 1 };

    function flush() {

        if (!pending) return;

        const { rect, pix, delay, disposal } = pending;

        const w = new ByteWriter();

        // Graphic Control Extension (indice 0 = trasparente)
        w.byte(0x21); w.byte(0xF9); w.byte(4);
        w.byte((disposal << 2) | 1);
        w.word(Math.max(2, delay || 4));
        w.byte(0);
        w.byte(0);

        // Image Descriptor
        w.byte(0x2C);
        w.word(rect.x); w.word(rect.y);
        w.word(rect.w); w.word(rect.h);
        w.byte(0);

        w.byte(8);                                                      // min code size

        const lzw = lzwEncode(pix, 8);

        for (let i = 0; i < lzw.length; i += 255) {

            const chunk = lzw.slice(i, i + 255);

            w.byte(chunk.length);
            w.bytes(chunk);
        }

        w.byte(0);

        parts.push(new Blob([w.result()]));

        pending = null;
    }

    // dopo questo fotogramma il precedente va cancellato: deve coprire TUTTO cio' che e' visibile
    function makeClearing() {

        const r = union(pending.rect, bounds(i => prev[i] !== 0)) || EMPTY;

        pending.rect = r;
        pending.pix = cut(prev, r, null);
        pending.disposal = 2;
    }

    function addFrame(data, delay = 4) {

        for (let p = 0, i = 0; p < data.length; p += 4, i++) {

            cur[i] = data[p + 3] < 128
                ? 0
                : lut[((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)];
        }

        if (!prev) {

            const rect = bounds(i => cur[i] !== 0) || EMPTY;

            pending = { rect, pix: cut(cur, rect, null), delay, disposal: 1 };

            prev = cur;
            cur = new Uint8Array(total);

            return;
        }

        // fotogramma uguale al precedente: dura di piu', niente da scrivere
        const changed = bounds(i => cur[i] !== prev[i]);

        if (!changed) {

            pending.delay += delay;

            return;
        }

        // basta aggiungere pixel? (nessun "pieno" diventa "trasparente")
        let keep = true;

        for (let y = changed.y; y < changed.y + changed.h && keep; y++) {

            let i = y * width + changed.x;

            for (let x = 0; x < changed.w; x++, i++) {

                if (cur[i] === 0 && prev[i] !== 0) { keep = false; break; }
            }
        }

        let next;

        if (keep) {

            pending.disposal = 1;

            next = { rect: changed, pix: cut(cur, changed, prev), delay, disposal: 1 };

        } else {

            makeClearing();

            const rect = bounds(i => cur[i] !== 0) || EMPTY;

            next = { rect, pix: cut(cur, rect, null), delay, disposal: 1 };
        }

        flush();

        pending = next;

        const t = prev;

        prev = cur;
        cur = t;
    }

    function finish() {

        // dopo l'ultimo fotogramma si ricomincia: lo schermo deve essere pulito
        if (pending) {

            makeClearing();

            flush();
        }

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

    const delays = options.delays || frames.map(() => 4);

    if (!frames.length) throw new Error('Nessun frame da codificare.');

    const pb = createPaletteBuilder();
    frames.forEach(f => pb.add(f));

    const gw = createGifWriter(width, height, { ...pb.finish(true), loop: options.loop || 0 });
    frames.forEach((f, i) => gw.addFrame(f, delays[i]));

    return new Uint8Array(await gw.finish().arrayBuffer());
}