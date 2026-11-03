// ============================================================
// ENCODER APPLE PRORES 4444 CON TRASPARENZA (nessuna dipendenza)
// + contenitore QuickTime .mov
//
// Perche': Safari / iPhone / iPad / Mac mostrano trasparente solo
// l'HEVC "con alfa", che il browser non sa creare (serve il
// codificatore di macOS). Il ProRes 4444 e' il formato professionale
// di Apple con canale alfa: QuickTime, Final Cut, Motion lo leggono, e
// sul Mac si converte in HEVC trasparente con un clic destro
// (Servizi > Codifica file video selezionati > "Mantieni trasparenza").
//
// Formato: SMPTE RDD 36 (ProRes), 4:4:4 a 10 bit + alfa a 8 bit,
// BT.709. Si scrive A FLUSSO: ogni fotogramma viene compresso subito,
// in memoria restano solo i byte compressi (in Blob).
// ============================================================


// ------------------------------------------------------------
// SCRITTURA A BIT
// ------------------------------------------------------------

class BitWriter {

    constructor(size = 1 << 16) {
        this.buf = new Uint8Array(size);
        this.pos = 0;          // byte
        this.acc = 0;          // bit in attesa
        this.n = 0;            // quanti bit in acc
    }

    ensure(extra) {
        if (this.pos + extra <= this.buf.length) return;
        let s = this.buf.length;
        while (s < this.pos + extra) s *= 2;
        const nb = new Uint8Array(s);
        nb.set(this.buf.subarray(0, this.pos));
        this.buf = nb;
    }

    // scrive i "bits" bit meno significativi di v (bits <= 24)
    put(bits, v) {
        if (bits === 0) return;
        this.acc = (this.acc << bits) | (v & ((1 << bits) - 1));
        this.n += bits;
        if (this.n >= 8) {
            this.ensure(4);
            while (this.n >= 8) {
                this.n -= 8;
                this.buf[this.pos++] = (this.acc >>> this.n) & 255;
            }
            this.acc &= (1 << this.n) - 1;
        }
    }

    // bit lunghi (fino a 32) spezzati in due
    putLong(bits, v) {
        if (bits > 16) {
            this.put(bits - 16, Math.floor(v / 65536));
            this.put(16, v & 0xFFFF);
        } else {
            this.put(bits, v);
        }
    }

    // completa l'ultimo byte con zeri
    flush() {
        if (this.n > 0) this.put(8 - this.n, 0);
    }

    bytesWritten() {
        return this.pos;
    }
}


// ------------------------------------------------------------
// CODICI A LUNGHEZZA VARIABILE (Rice / exp-Golomb, come da RDD 36)
// codebook: bit 5-7 = ordine Rice, bit 2-4 = ordine exp-Golomb,
//           bit 0-1 = soglia di passaggio
// ------------------------------------------------------------

function log2floor(v) {
    return 31 - Math.clz32(v);
}

function putCodeword(bw, codebook, val) {

    const switchBits = (codebook & 3) + 1;
    const riceOrder = codebook >> 5;
    const expOrder = (codebook >> 2) & 7;
    const switchVal = switchBits << riceOrder;

    if (val >= switchVal) {

        val -= switchVal - (1 << expOrder);
        const exponent = log2floor(val);
        const zeros = exponent - expOrder + switchBits;
        // zeri iniziali e poi il valore su exponent+1 bit
        for (let z = zeros; z > 0; z -= 24) bw.put(Math.min(24, z), 0);
        bw.putLong(exponent + 1, val);

    } else {

        const exponent = val >> riceOrder;
        for (let z = exponent; z > 0; z -= 24) bw.put(Math.min(24, z), 0);
        bw.put(1, 1);
        if (riceOrder) bw.put(riceOrder, val);
    }
}

const FIRST_DC_CB = 0xB8;
const DC_CODEBOOK = [0x04, 0x28, 0x28, 0x4D, 0x4D, 0x70, 0x70];
const RUN_TO_CB = [0x06, 0x06, 0x05, 0x05, 0x04, 0x29, 0x29, 0x29, 0x29, 0x28, 0x28, 0x28, 0x28, 0x28, 0x28, 0x4C];
const LEV_TO_CB = [0x04, 0x0A, 0x05, 0x06, 0x04, 0x28, 0x28, 0x28, 0x28, 0x4C];

const PROGRESSIVE_SCAN = [
    0, 1, 8, 9, 2, 3, 10, 11,
    16, 17, 24, 25, 18, 19, 26, 27,
    4, 5, 12, 20, 13, 6, 7, 14,
    21, 28, 29, 22, 15, 23, 30, 31,
    32, 33, 40, 48, 41, 34, 35, 42,
    49, 56, 57, 50, 43, 36, 37, 44,
    51, 58, 59, 52, 45, 38, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63
];

// numero con segno -> codice senza segno (0, -1, 1, -2, 2 ... -> 0, 1, 2, 3, 4 ...)
const makeCode = x => x >= 0 ? x * 2 : -x * 2 - 1;


// ------------------------------------------------------------
// DCT 8x8 (ortonormale, separabile, con tabella dei coseni)
// ------------------------------------------------------------

const COS = (() => {
    const t = new Float64Array(64);
    for (let u = 0; u < 8; u++) {
        const cu = u === 0 ? Math.SQRT1_2 : 1;
        for (let x = 0; x < 8; x++) {
            t[u * 8 + x] = 0.5 * cu * Math.cos((2 * x + 1) * u * Math.PI / 16);
        }
    }
    return t;
})();

const tmpBlock = new Float64Array(64);

// in: 64 valori (pixel 10 bit), out: 64 coefficienti
function fdct(inp, out) {

    // righe
    for (let y = 0; y < 8; y++) {
        const r = y * 8;
        for (let u = 0; u < 8; u++) {
            const c = u * 8;
            tmpBlock[r + u] =
                COS[c] * inp[r] + COS[c + 1] * inp[r + 1] + COS[c + 2] * inp[r + 2] + COS[c + 3] * inp[r + 3] +
                COS[c + 4] * inp[r + 4] + COS[c + 5] * inp[r + 5] + COS[c + 6] * inp[r + 6] + COS[c + 7] * inp[r + 7];
        }
    }

    // colonne
    for (let x = 0; x < 8; x++) {
        for (let v = 0; v < 8; v++) {
            const c = v * 8;
            out[v * 8 + x] =
                COS[c] * tmpBlock[x] + COS[c + 1] * tmpBlock[8 + x] + COS[c + 2] * tmpBlock[16 + x] + COS[c + 3] * tmpBlock[24 + x] +
                COS[c + 4] * tmpBlock[32 + x] + COS[c + 5] * tmpBlock[40 + x] + COS[c + 6] * tmpBlock[48 + x] + COS[c + 7] * tmpBlock[56 + x];
        }
    }
}


// ------------------------------------------------------------
// FOTOGRAMMA
// ------------------------------------------------------------

/*
    Struttura dei dati nel dominio del codec (come ffmpeg / Apple):
    coefficiente F = 4 x DCT ortonormale del pixel a 10 bit; il DC ha
    uno scostamento di 16384 (= pixel 512). Coefficiente codificato =
    F / (quant x matrice). Matrice: tutti 4 (quella di ProRes 4444).
*/

const QMAT = 4;

// una "fetta" (slice) = da 1 a 8 macroblocchi 16x16 sulla stessa riga
function sliceLayout(mbW, mbH, log2Max = 3) {

    const slices = [];

    for (let my = 0; my < mbH; my++) {

        let mx = 0;
        let j = log2Max;

        while (mx < mbW) {
            while (mbW - mx < (1 << j)) j--;
            slices.push({ mx, my, count: 1 << j });
            mx += 1 << j;
        }
    }

    return slices;
}


export function createProResEncoder(width, height, { quant = 2 } = {}) {

    const mbW = (width + 15) >> 4;
    const mbH = (height + 15) >> 4;
    const PW = mbW * 16;           // dimensioni riempite fino a multipli di 16
    const PH = mbH * 16;

    const slices = sliceLayout(mbW, mbH);

    // piani a 10 bit (Y, Cb, Cr) e alfa a 8 bit, con bordo replicato
    const Y = new Float32Array(PW * PH);
    const U = new Float32Array(PW * PH);
    const V = new Float32Array(PW * PH);
    const A = new Uint8Array(PW * PH);

    let step = quant * QMAT;             // passo di quantizzazione nel dominio F (per fetta)
    const blockIn = new Float64Array(64);
    const blockOut = new Float64Array(64);

    // coefficienti di una fetta (max 8 MB x 4 blocchi x 64)
    const coefs = new Int32Array(32 * 64);

    // ---- RGB(A) 8 bit -> Y'CbCr 10 bit BT.709 (gamma video) ----
    function convert(rgba) {

        for (let y = 0; y < PH; y++) {

            const sy = Math.min(y, height - 1);

            for (let x = 0; x < PW; x++) {

                const sx = Math.min(x, width - 1);
                const s = (sy * width + sx) * 4;
                const d = y * PW + x;

                const r = rgba[s] / 255, g = rgba[s + 1] / 255, b = rgba[s + 2] / 255;
                const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;

                Y[d] = 64 + 876 * yy;
                U[d] = 512 + 896 * (b - yy) / 1.8556;
                V[d] = 512 + 896 * (r - yy) / 1.5748;
                A[d] = rgba[s + 3];
            }
        }
    }

    // ---- un piano di una fetta: DC + AC ----
    function encodePlane(bw, plane, sl, chroma) {

        const nBlocks = sl.count * 4;

        // ordine dei 4 blocchi 8x8 di ogni macroblocco (come il decoder):
        //   luma:  alto-sx, alto-dx, basso-sx, basso-dx   (per righe)
        //   croma: alto-sx, basso-sx, alto-dx, basso-dx   (per colonne)
        let b = 0;

        for (let m = 0; m < sl.count; m++) {

            const ox = (sl.mx + m) * 16;
            const oy = sl.my * 16;

            for (let k = 0; k < 4; k++, b++) {

                const bx = ox + (chroma ? (k >> 1) : (k & 1)) * 8;
                const by = oy + (chroma ? (k & 1) : (k >> 1)) * 8;

                for (let yy = 0; yy < 8; yy++) {
                    const row = (by + yy) * PW + bx;
                    for (let xx = 0; xx < 8; xx++) blockIn[yy * 8 + xx] = plane[row + xx];
                }

                fdct(blockIn, blockOut);

                const base = b * 64;

                // DC: (4*F - 16384) / passo
                coefs[base] = Math.round((4 * blockOut[0] - 16384) / step);

                for (let i = 1; i < 64; i++) {
                    coefs[base + i] = Math.round(4 * blockOut[i] / step);
                }
            }
        }

        const start = bw.bytesWritten();

        // ---- DC ----
        let prevDc = coefs[0];
        putCodeword(bw, FIRST_DC_CB, makeCode(prevDc));

        let code = 5;      // contesto iniziale (come il decoder)
        let sign = 0;      // segno del delta precedente: 0 o -1

        for (let i = 1; i < nBlocks; i++) {

            const dc = coefs[i * 64];
            let delta = dc - prevDc;
            const newSign = delta < 0 ? -1 : 0;

            delta = (delta ^ sign) - sign;

            const c = makeCode(delta);
            putCodeword(bw, DC_CODEBOOK[Math.min(code, 6)], c);

            code = c;
            sign = newSign;
            prevDc = dc;
        }

        // ---- AC: per ogni posizione della scansione, attraverso tutti i blocchi ----
        let run = 0;
        let runCtx = 4;
        let levCtx = 2;

        for (let i = 1; i < 64; i++) {

            const s = PROGRESSIVE_SCAN[i];

            for (let blk = 0; blk < nBlocks; blk++) {

                const level = coefs[blk * 64 + s];

                if (level) {

                    const abs = level < 0 ? -level : level;

                    putCodeword(bw, RUN_TO_CB[Math.min(runCtx, 15)], run);
                    putCodeword(bw, LEV_TO_CB[Math.min(levCtx, 9)], abs - 1);
                    bw.put(1, level < 0 ? 1 : 0);

                    runCtx = run;
                    levCtx = abs;
                    run = 0;

                } else {
                    run++;
                }
            }
        }

        bw.flush();

        return bw.bytesWritten() - start;
    }

    // ---- alfa a 8 bit: differenze + ripetizioni, riga per riga della fetta ----
    function encodeAlpha(bw, sl) {

        const start = bw.bytesWritten();
        const sw = sl.count * 16;
        const total = sw * 16;

        const at = idx => A[(sl.my * 16 + ((idx / sw) | 0)) * PW + sl.mx * 16 + (idx % sw)];

        const putDiff = (cur, prev) => {

            let diff = (cur - prev) & 255;
            if (diff >= 256 - 8) diff -= 256;

            if (diff < -8 || diff > 8 || diff === 0) {
                bw.put(1, 1);
                bw.put(8, diff);
            } else {
                bw.put(1, 0);
                bw.put(3, Math.abs(diff) - 1);
                bw.put(1, diff < 0 ? 1 : 0);
            }
        };

        const putRun = r => {
            if (r) {
                bw.put(1, 0);
                if (r < 16) bw.put(4, r);
                else bw.put(15, r);
            } else {
                bw.put(1, 1);
            }
        };

        let prev = 255;
        let idx = 0;
        let run = 0;

        let cur = at(idx++);
        putDiff(cur, prev);
        prev = cur;

        while (idx < total) {

            cur = at(idx++);

            if (cur !== prev) {
                putRun(run);
                putDiff(cur, prev);
                prev = cur;
                run = 0;
            } else {
                run++;
            }
        }

        if (run) putRun(run);

        bw.flush();

        return bw.bytesWritten() - start;
    }

    // ---- fotogramma completo ----
    function encodeFrame(rgba) {

        convert(rgba);

        const bw = new BitWriter(Math.max(1 << 16, PW * PH));

        // spazio per: dimensione (4) 'icpf' (4) intestazione (148) immagine (8) tabella fette
        const headerLen = 8 + 148;
        const tableLen = slices.length * 2;
        const picStart = headerLen;
        const dataStart = picStart + 8 + tableLen;

        bw.ensure(dataStart);
        bw.pos = dataStart;

        const sizes = new Uint16Array(slices.length);

        for (let s = 0; s < slices.length; s++) {

            const sl = slices[s];
            const sliceStart = bw.bytesWritten();

            // una fetta non puo' superare 65535 byte: se succede (dettagli
            // molto fitti) la si rifa' con una quantizzazione piu' alta
            let q = quant;

            for (;;) {

                step = q * QMAT;
                bw.pos = sliceStart;

                // intestazione della fetta (8 byte), riempita dopo
                bw.ensure(8);
                bw.pos += 8;

                const ySize = encodePlane(bw, Y, sl, false);
                const uSize = encodePlane(bw, U, sl, true);
                const vSize = encodePlane(bw, V, sl, true);
                encodeAlpha(bw, sl);

                const total = bw.bytesWritten() - sliceStart;

                if (total > 65535 && q < 128) {
                    q = Math.min(128, q * 2);
                    continue;
                }

                if (total > 65535) throw new Error('ProRes: fetta troppo grande');

                const h = bw.buf;
                h[sliceStart] = 8 << 3;
                h[sliceStart + 1] = q;
                h[sliceStart + 2] = ySize >> 8; h[sliceStart + 3] = ySize & 255;
                h[sliceStart + 4] = uSize >> 8; h[sliceStart + 5] = uSize & 255;
                h[sliceStart + 6] = vSize >> 8; h[sliceStart + 7] = vSize & 255;

                sizes[s] = total;
                break;
            }
        }

        const out = bw.buf.subarray(0, bw.bytesWritten());
        const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

        // ---- intestazione del fotogramma ----
        dv.setUint32(0, out.length);
        out.set([0x69, 0x63, 0x70, 0x66], 4);           // 'icpf'
        dv.setUint16(8, 148);                           // dimensione intestazione
        dv.setUint16(10, 0);                            // versione
        out.set([0x61, 0x70, 0x6C, 0x30], 12);          // creatore 'apl0'
        dv.setUint16(16, width);
        dv.setUint16(18, height);
        out[20] = 3 << 6;                               // 4:4:4, progressivo
        out[21] = 0;
        out[22] = 1;                                    // primari BT.709
        out[23] = 1;                                    // trasferimento BT.709
        out[24] = 1;                                    // matrice BT.709
        out[25] = (4 << 4) | 1;                         // alfa a 8 bit
        out[26] = 0;
        out[27] = 3;                                    // matrici di quantizzazione presenti
        out.fill(QMAT, 28, 28 + 128);                   // luma + croma: tutti 4

        // ---- intestazione dell'immagine ----
        const p = picStart;
        out[p] = 0x40;                                  // 8 byte
        dv.setUint32(p + 1, out.length - p);
        dv.setUint16(p + 5, slices.length);
        out[p + 7] = 3 << 4;                            // fette larghe fino a 8 MB, alte 1

        for (let s = 0; s < slices.length; s++) dv.setUint16(p + 8 + s * 2, sizes[s]);

        return out.slice();
    }

    return { encodeFrame, width, height };
}


// ============================================================
// CONTENITORE QUICKTIME (.mov) A FLUSSO
// ============================================================

function atom(type, ...parts) {

    let len = 8;
    for (const p of parts) len += p.length;

    const out = new Uint8Array(len);
    const dv = new DataView(out.buffer);

    dv.setUint32(0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);

    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }

    return out;
}

function bytes(spec) {

    // spec: lista di [tipo, valore]; tipi: u8 u16 u32 i16 i32 u64 str4 raw
    let len = 0;
    for (const [t, v] of spec) {
        len += t === 'u8' ? 1 : t === 'u16' || t === 'i16' ? 2 : t === 'u64' ? 8 : t === 'raw' ? v.length : 4;
    }

    const out = new Uint8Array(len);
    const dv = new DataView(out.buffer);
    let o = 0;

    for (const [t, v] of spec) {
        if (t === 'u8') { out[o] = v; o += 1; }
        else if (t === 'u16') { dv.setUint16(o, v); o += 2; }
        else if (t === 'i16') { dv.setInt16(o, v); o += 2; }
        else if (t === 'u32') { dv.setUint32(o, v >>> 0); o += 4; }
        else if (t === 'i32') { dv.setInt32(o, v); o += 4; }
        else if (t === 'u64') { dv.setUint32(o, Math.floor(v / 4294967296)); dv.setUint32(o + 4, v >>> 0); o += 8; }
        else if (t === 'str4') { for (let i = 0; i < 4; i++) out[o + i] = v.charCodeAt(i); o += 4; }
        else if (t === 'raw') { out.set(v, o); o += v.length; }
    }

    return out;
}

const MATRIX = [['u32', 0x00010000], ['u32', 0], ['u32', 0], ['u32', 0], ['u32', 0x00010000], ['u32', 0], ['u32', 0], ['u32', 0], ['u32', 0x40000000]];

/*
    createMovWriter(width, height)
      addFrame(bytes, durationMs)
      finish() -> Blob .mov

    Scala dei tempi: 1000 (millisecondi). Il blocco dei dati usa la
    dimensione a 64 bit e gli offset sono a 64 bit (co64): nessun
    limite di 4 GB.
*/

export function createMovWriter(width, height) {

    const TIMESCALE = 1000;

    const frames = [];         // Blob dei fotogrammi
    const sizes = [];
    const durations = [];

    let dataLen = 0;

    function addFrame(data, durationMs) {
        frames.push(new Blob([data]));
        sizes.push(data.length);
        durations.push(Math.max(1, Math.round(durationMs)));
        dataLen += data.length;
    }

    function finish() {

        const ftyp = atom('ftyp', bytes([['str4', 'qt  '], ['u32', 0x00000200], ['str4', 'qt  ']]));
        const wide = bytes([['u32', 8], ['str4', 'wide']]);

        // mdat con dimensione a 64 bit
        const mdatHead = bytes([['u32', 1], ['str4', 'mdat'], ['u64', 16 + dataLen]]);
        const firstOffset = ftyp.length + wide.length + mdatHead.length;

        const total = durations.reduce((a, b) => a + b, 0);

        const mvhd = atom('mvhd', bytes([
            ['u32', 0], ['u32', 0], ['u32', 0],
            ['u32', TIMESCALE], ['u32', total],
            ['u32', 0x00010000], ['u16', 0x0100], ['raw', new Uint8Array(10)],
            ...MATRIX,
            ['raw', new Uint8Array(24)],
            ['u32', 2]
        ]));

        const tkhd = atom('tkhd', bytes([
            ['u32', 0x0000000F], ['u32', 0], ['u32', 0],
            ['u32', 1], ['u32', 0], ['u32', total],
            ['raw', new Uint8Array(8)],
            ['u16', 0], ['u16', 0], ['u16', 0], ['u16', 0],
            ...MATRIX,
            ['u32', width * 65536], ['u32', height * 65536]
        ]));

        const elst = atom('elst', bytes([['u32', 0], ['u32', 1], ['u32', total], ['u32', 0], ['u32', 0x00010000]]));
        const edts = atom('edts', elst);

        const mdhd = atom('mdhd', bytes([
            ['u32', 0], ['u32', 0], ['u32', 0],
            ['u32', TIMESCALE], ['u32', total],
            ['u16', 0x7FFF], ['u16', 0]
        ]));

        const name = s => { const b = new Uint8Array(1 + s.length); b[0] = s.length; for (let i = 0; i < s.length; i++) b[i + 1] = s.charCodeAt(i); return b; };

        const hdlrM = atom('hdlr', bytes([['u32', 0], ['str4', 'mhlr'], ['str4', 'vide'], ['str4', 'appl'], ['u32', 0], ['u32', 0], ['raw', name('VideoHandler')]]));
        const hdlrD = atom('hdlr', bytes([['u32', 0], ['str4', 'dhlr'], ['str4', 'alis'], ['str4', 'appl'], ['u32', 0], ['u32', 0], ['raw', name('DataHandler')]]));

        const vmhd = atom('vmhd', bytes([['u32', 1], ['u16', 0x40], ['u16', 0x8000], ['u16', 0x8000], ['u16', 0x8000]]));
        const dref = atom('dref', bytes([['u32', 0], ['u32', 1]]), atom('alis', bytes([['u32', 1]])));
        const dinf = atom('dinf', dref);

        // descrizione del formato: ProRes 4444 ('ap4h'), profondita' 32 = con alfa
        const compressor = new Uint8Array(32);
        const cname = 'Apple ProRes 4444';
        compressor[0] = cname.length;
        for (let i = 0; i < cname.length; i++) compressor[i + 1] = cname.charCodeAt(i);

        const ap4h = atom('ap4h', bytes([
            ['raw', new Uint8Array(6)], ['u16', 1],
            ['u16', 0], ['u16', 0], ['str4', 'appl'],
            ['u32', 0], ['u32', 0x00000200],
            ['u16', width], ['u16', height],
            ['u32', 0x00480000], ['u32', 0x00480000],
            ['u32', 0], ['u16', 1],
            ['raw', compressor],
            ['u16', 32], ['i16', -1]
        ]),
            atom('colr', bytes([['str4', 'nclc'], ['u16', 1], ['u16', 1], ['u16', 1]])),
            atom('fiel', bytes([['u8', 1], ['u8', 0]])),
            atom('pasp', bytes([['u32', 1], ['u32', 1]]))
        );

        const stsd = atom('stsd', bytes([['u32', 0], ['u32', 1]]), ap4h);

        // durate: ripetizioni compattate
        const runs = [];
        for (const d of durations) {
            if (runs.length && runs[runs.length - 1][1] === d) runs[runs.length - 1][0]++;
            else runs.push([1, d]);
        }
        const stts = atom('stts', bytes([['u32', 0], ['u32', runs.length], ...runs.flatMap(([c, d]) => [['u32', c], ['u32', d]])]));

        // un fotogramma per "chunk": semplice e sempre corretto
        const stsc = atom('stsc', bytes([['u32', 0], ['u32', 1], ['u32', 1], ['u32', 1], ['u32', 1]]));

        const stszB = new Uint8Array(12 + sizes.length * 4);
        { const dv = new DataView(stszB.buffer); dv.setUint32(8, sizes.length); sizes.forEach((s, i) => dv.setUint32(12 + i * 4, s)); }
        const stsz = atom('stsz', stszB);

        const co64B = new Uint8Array(8 + sizes.length * 8);
        {
            const dv = new DataView(co64B.buffer);
            dv.setUint32(4, sizes.length);
            let off = firstOffset;
            sizes.forEach((s, i) => {
                dv.setUint32(8 + i * 8, Math.floor(off / 4294967296));
                dv.setUint32(12 + i * 8, off >>> 0);
                off += s;
            });
        }
        const co64 = atom('co64', co64B);

        const stbl = atom('stbl', stsd, stts, stsc, stsz, co64);
        const minf = atom('minf', vmhd, hdlrD, dinf, stbl);
        const mdia = atom('mdia', mdhd, hdlrM, minf);
        const trak = atom('trak', tkhd, edts, mdia);
        const moov = atom('moov', mvhd, trak);

        return new Blob([ftyp, wide, mdatHead, ...frames, moov], { type: 'video/quicktime' });
    }

    return { addFrame, finish };
}
