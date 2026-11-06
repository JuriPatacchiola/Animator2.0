// ============================================================
// WebM VP9 CON TRASPARENZA - nessuna dipendenza
//
// Il browser sa codificare VP9 (WebCodecs, VideoEncoder) ma non la
// trasparenza: quella si fa come ffmpeg / libvpx (yuva420p):
//
//   - un flusso VP9 per i COLORI (I420);
//   - un secondo flusso VP9 per la TRASPARENZA: il canale alfa e'
//     il piano Y di un'immagine in scala di grigi (U e V neutri);
//   - nel file WebM ogni fotogramma e' un BlockGroup con il flusso dei
//     colori nel Block e quello dell'alfa in BlockAdditions (BlockAddID 1),
//     e la traccia ha AlphaMode = 1.
//
// Ogni fotogramma ha il suo tempo esatto (in millisecondi): niente
// registrazione in tempo reale, quindi nessun fotogramma perso o
// spostato. I fotogrammi uguali di fila sono gia' uniti a monte.
// ============================================================


// ------------------------------------------------------------
// ELEMENTI EBML
// ------------------------------------------------------------

const enc = new TextEncoder();

function concat(parts) {

    let n = 0;

    for (const p of parts) n += p.length;

    const out = new Uint8Array(n);

    let o = 0;

    for (const p of parts) { out.set(p, o); o += p.length; }

    return out;
}

// lunghezza di un elemento (vint: piu' corto possibile)
function sizeBytes(n) {

    for (let len = 1; len <= 8; len++) {

        // len=8 puo' arrivare a 2^56 - 2
        if (n < Math.pow(2, 7 * len) - 1) {

            const out = new Uint8Array(len);

            let v = n;

            for (let i = len - 1; i >= 0; i--) {

                out[i] = v % 256;
                v = Math.floor(v / 256);
            }

            out[0] |= 0x80 >> (len - 1);

            return out;
        }
    }

    throw new Error('Elemento troppo grande.');
}

const el = (id, ...content) => {

    const body = concat(content);

    return concat([Uint8Array.from(id), sizeBytes(body.length), body]);
};

// intero senza segno, il piu' corto possibile
function uintBytes(n) {

    if (n === 0) return Uint8Array.from([0]);

    const arr = [];

    let v = n;

    while (v > 0) { arr.unshift(v % 256); v = Math.floor(v / 256); }

    return Uint8Array.from(arr);
}

// intero con segno (per ReferenceBlock)
function intBytes(n) {

    for (let len = 1; len <= 4; len++) {

        const lim = Math.pow(2, 8 * len - 1);

        if (n >= -lim && n < lim) {

            const out = new Uint8Array(len);

            let v = n < 0 ? n + Math.pow(2, 8 * len) : n;

            for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }

            return out;
        }
    }

    throw new Error('Numero fuori misura.');
}

const uintEl = (id, n) => el(id, uintBytes(n));

const strEl = (id, s) => el(id, enc.encode(s));

function floatEl(id, x) {

    const b = new Uint8Array(8);

    new DataView(b.buffer).setFloat64(0, x);

    return el(id, b);
}

// intero senza segno di larghezza fissa (CueClusterPosition: la lunghezza non dipende dal valore)
function uint8El(id, n) {

    const b = new Uint8Array(8);

    let v = n;

    for (let i = 7; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }

    return el(id, b);
}

const ID = {
    EBML: [0x1A, 0x45, 0xDF, 0xA3],
    EBMLVersion: [0x42, 0x86],
    EBMLReadVersion: [0x42, 0xF7],
    EBMLMaxIDLength: [0x42, 0xF2],
    EBMLMaxSizeLength: [0x42, 0xF3],
    DocType: [0x42, 0x82],
    DocTypeVersion: [0x42, 0x87],
    DocTypeReadVersion: [0x42, 0x85],
    Segment: [0x18, 0x53, 0x80, 0x67],
    Info: [0x15, 0x49, 0xA9, 0x66],
    TimecodeScale: [0x2A, 0xD7, 0xB1],
    Duration: [0x44, 0x89],
    MuxingApp: [0x4D, 0x80],
    WritingApp: [0x57, 0x41],
    Tracks: [0x16, 0x54, 0xAE, 0x6B],
    TrackEntry: [0xAE],
    TrackNumber: [0xD7],
    TrackUID: [0x73, 0xC5],
    TrackType: [0x83],
    FlagLacing: [0x9C],
    CodecID: [0x86],
    Video: [0xE0],
    PixelWidth: [0xB0],
    PixelHeight: [0xBA],
    AlphaMode: [0x53, 0xC0],
    Colour: [0x55, 0xB0],
    MatrixCoefficients: [0x55, 0xB1],
    Range: [0x55, 0xB9],
    TransferCharacteristics: [0x55, 0xBA],
    Primaries: [0x55, 0xBB],
    Cluster: [0x1F, 0x43, 0xB6, 0x75],
    Timecode: [0xE7],
    BlockGroup: [0xA0],
    Block: [0xA1],
    BlockDuration: [0x9B],
    ReferenceBlock: [0xFB],
    BlockAdditions: [0x75, 0xA1],
    BlockMore: [0xA6],
    BlockAddID: [0xEE],
    BlockAdditional: [0xA5],
    Cues: [0x1C, 0x53, 0xBB, 0x6B],
    CuePoint: [0xBB],
    CueTime: [0xB3],
    CueTrackPositions: [0xB7],
    CueTrack: [0xF7],
    CueClusterPosition: [0xF1]
};


// ------------------------------------------------------------
// MUXER
// ------------------------------------------------------------

/*
    frames: [{ ms (inizio), dur (durata, ms), key (true se fotogramma chiave),
               color (Uint8Array VP9), alpha (Uint8Array VP9 dell'alfa, o null) }]
*/

export function muxWebm({ width, height, frames, hasAlpha = true, matrix = 601 }) {

    if (!frames.length) throw new Error('Nessun fotogramma da salvare.');

    const last = frames[frames.length - 1];

    const totalMs = last.ms + last.dur;

    const header = el(ID.EBML,
        uintEl(ID.EBMLVersion, 1),
        uintEl(ID.EBMLReadVersion, 1),
        uintEl(ID.EBMLMaxIDLength, 4),
        uintEl(ID.EBMLMaxSizeLength, 8),
        strEl(ID.DocType, 'webm'),
        uintEl(ID.DocTypeVersion, 4),
        uintEl(ID.DocTypeReadVersion, 2)
    );

    const info = el(ID.Info,
        uintEl(ID.TimecodeScale, 1000000),
        floatEl(ID.Duration, totalMs),
        strEl(ID.MuxingApp, 'Animatore 2D'),
        strEl(ID.WritingApp, 'Animatore 2D')
    );

    const videoParts = [uintEl(ID.PixelWidth, width), uintEl(ID.PixelHeight, height)];

    if (hasAlpha) videoParts.push(uintEl(ID.AlphaMode, 1));

    // il file dice esplicitamente con quale matrice sono stati calcolati i colori (il browser altrimenti la indovina)
    const cs = matrix === 601 ? 6 : 1;

    videoParts.push(el(ID.Colour,
        uintEl(ID.MatrixCoefficients, cs),
        uintEl(ID.Range, 1),
        uintEl(ID.TransferCharacteristics, cs),
        uintEl(ID.Primaries, cs)
    ));

    const tracks = el(ID.Tracks,
        el(ID.TrackEntry,
            uintEl(ID.TrackNumber, 1),
            uintEl(ID.TrackUID, 1),
            uintEl(ID.TrackType, 1),
            uintEl(ID.FlagLacing, 0),
            strEl(ID.CodecID, 'V_VP9'),
            el(ID.Video, ...videoParts)
        )
    );

    // ---- cluster: ne parte uno a ogni fotogramma chiave (o prima di 30 s)
    const clusters = [];

    let cur = null;

    const flush = () => { if (cur) { clusters.push(cur); cur = null; } };

    let prevMs = 0;

    frames.forEach((f, i) => {

        if (!cur || f.key || f.ms - cur.start > 30000) {

            flush();

            cur = { start: f.ms, key: f.key, parts: [] };
        }

        const rel = f.ms - cur.start;

        const blockHead = Uint8Array.from([0x81, (rel >> 8) & 255, rel & 255, 0x00]);

        const group = [
            el(ID.Block, blockHead, f.color)
        ];

        if (hasAlpha && f.alpha) {

            group.push(el(ID.BlockAdditions,
                el(ID.BlockMore, uintEl(ID.BlockAddID, 1), el(ID.BlockAdditional, f.alpha))
            ));
        }

        group.push(uintEl(ID.BlockDuration, f.dur));

        // senza ReferenceBlock il fotogramma conta come "chiave"
        if (!f.key) group.push(el(ID.ReferenceBlock, intBytes(prevMs - f.ms)));

        cur.parts.push(el(ID.BlockGroup, ...group));

        prevMs = f.ms;
    });

    flush();

    const clusterBytes = clusters.map(c => el(ID.Cluster, uintEl(ID.Timecode, c.start), ...c.parts));

    // ---- Cues (indice per i salti), messi prima dei cluster: la lunghezza non dipende dalle posizioni
    const cueSize = clusters.map(c => el(ID.CuePoint,
        uintEl(ID.CueTime, c.start),
        el(ID.CueTrackPositions, uintEl(ID.CueTrack, 1), uint8El(ID.CueClusterPosition, 0))
    ).length);

    const cuesLen = el(ID.Cues, new Uint8Array(cueSize.reduce((a, b) => a + b, 0))).length;

    let pos = info.length + tracks.length + cuesLen;

    const cuePoints = clusters.map((c, i) => {

        const p = el(ID.CuePoint,
            uintEl(ID.CueTime, c.start),
            el(ID.CueTrackPositions, uintEl(ID.CueTrack, 1), uint8El(ID.CueClusterPosition, pos))
        );

        pos += clusterBytes[i].length;

        return p;
    });

    const cues = el(ID.Cues, ...cuePoints);

    if (cues.length !== cuesLen) throw new Error('Indice WebM incoerente.');

    const segment = el(ID.Segment, info, tracks, cues, ...clusterBytes);

    return new Blob([header, segment], { type: 'video/webm' });
}


// ------------------------------------------------------------
// COLORI: RGBA (non premoltiplicato) -> I420 + piano alfa
//
// Matrice BT.709, intervallo "video" (16-235): e' quella che il browser
// presume per questi video. Le tinte (U, V) di ogni quadratino 2x2 sono la
// media dei soli pixel visibili: i pixel trasparenti non "sporcano" il
// colore dei bordi (nel 4:2:0 le tinte sono condivise da 4 pixel).
// ------------------------------------------------------------

export function rgbaToI420(rgba, w, h, matrix = 601) {

    const kr = matrix === 601 ? 0.299 : 0.2126;
    const kb = matrix === 601 ? 0.114 : 0.0722;
    const kg = 1 - kr - kb;

    const cw = (w + 1) >> 1;
    const ch = (h + 1) >> 1;

    const Y = new Uint8Array(w * h);
    const U = new Uint8Array(cw * ch);
    const V = new Uint8Array(cw * ch);
    const A = new Uint8Array(w * h);

    const sy = 219 / 255;
    const sc = 224 / 255;

    for (let cy = 0; cy < ch; cy++) {

        for (let cx = 0; cx < cw; cx++) {

            let n = 0, nAll = 0;
            let r = 0, g = 0, b = 0;
            let ra = 0, ga = 0, ba = 0;

            for (let dy = 0; dy < 2; dy++) {

                const y = cy * 2 + dy;

                if (y >= h) continue;

                for (let dx = 0; dx < 2; dx++) {

                    const x = cx * 2 + dx;

                    if (x >= w) continue;

                    const i = (y * w + x) * 4;

                    nAll++;

                    ra += rgba[i]; ga += rgba[i + 1]; ba += rgba[i + 2];

                    if (rgba[i + 3] > 0) { n++; r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; }
                }
            }

            // quadratino tutto trasparente: colore neutro (nero)
            if (n === 0) { r = 0; g = 0; b = 0; } else { r /= n; g /= n; b /= n; }

            const yMean = 16 + sy * (kr * r + kg * g + kb * b);

            U[cy * cw + cx] = Math.max(0, Math.min(255, Math.round(128 + sc * (b - (kr * r + kg * g + kb * b)) / (2 * (1 - kb)))));
            V[cy * cw + cx] = Math.max(0, Math.min(255, Math.round(128 + sc * (r - (kr * r + kg * g + kb * b)) / (2 * (1 - kr)))));

            for (let dy = 0; dy < 2; dy++) {

                const y = cy * 2 + dy;

                if (y >= h) continue;

                for (let dx = 0; dx < 2; dx++) {

                    const x = cx * 2 + dx;

                    if (x >= w) continue;

                    const i = (y * w + x) * 4;

                    const a = rgba[i + 3];

                    A[y * w + x] = a;

                    // pixel visibile: il suo vero valore; trasparente: la media del quadratino (non si vede, ma comprime meglio)
                    Y[y * w + x] = a > 0
                        ? Math.max(0, Math.min(255, Math.round(16 + sy * (kr * rgba[i] + kg * rgba[i + 1] + kb * rgba[i + 2]))))
                        : Math.round(yMean);
                }
            }
        }
    }

    return { Y, U, V, A, cw, ch };
}

// un VideoFrame I420 da tre piani
function i420Frame(Y, U, V, w, h, timestampUs, durationUs, colorSpace) {

    const buf = new Uint8Array(Y.length + U.length + V.length);

    buf.set(Y, 0);
    buf.set(U, Y.length);
    buf.set(V, Y.length + U.length);

    return new VideoFrame(buf, {
        format: 'I420',
        codedWidth: w,
        codedHeight: h,
        timestamp: timestampUs,
        duration: durationUs,
        colorSpace
    });
}


// ------------------------------------------------------------
// CODIFICA
// ------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/*
    Un flusso VP9. quantizer: 0 (qualita' massima) .. 63. Ritorna i pacchetti, uno per fotogramma.
*/

async function makeEncoder({ width, height, quantizer }) {

    const chunks = [];

    let error = null;

    const encoder = new VideoEncoder({
        output: (chunk) => {

            const data = new Uint8Array(chunk.byteLength);

            chunk.copyTo(data);

            chunks.push({ data, key: chunk.type === 'key', ts: chunk.timestamp });
        },
        error: (e) => { error = e; }
    });

    const config = {
        codec: 'vp09.00.10.08',
        width,
        height,
        framerate: 30,
        bitrate: 20_000_000,
        bitrateMode: 'quantizer',
        latencyMode: 'quality'
    };

    const sup = await VideoEncoder.isConfigSupported(config);

    if (!sup.supported) throw new Error('Questo browser non sa codificare VP9: usa Chrome o Edge.');

    encoder.configure(config);

    return {
        encode(frame, keyFrame) {

            if (error) throw error;

            encoder.encode(frame, { keyFrame, vp9: { quantizer } });
        },
        queue: () => encoder.encodeQueueSize,
        async finish() {

            await encoder.flush();

            encoder.close();

            if (error) throw error;

            return chunks;
        }
    };
}

/*
    width, height: pari. count fotogrammi; durations[i] in ms; render(i, canvas) disegna il fotogramma i
    (tela trasparente, misure width x height).
    Ritorna { blob, frames, ms }.
*/

export async function encodeWebmAlpha({
    width, height, count, durations, render,
    quantizer = 4, alphaQuantizer = 0, keyEvery = 60, matrix = 601, onProgress = null
}) {

    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {

        throw new Error('Questo browser non sa creare video VP9 (serve Chrome o Edge).');
    }

    if (width % 2 || height % 2) throw new Error(`Per il WebM le misure devono essere pari (${width}×${height}).`);

    const color = await makeEncoder({ width, height, quantizer });
    const alpha = await makeEncoder({ width, height, quantizer: alphaQuantizer });

    const cv = document.createElement('canvas');

    const colorSpace = { primaries: matrix === 601 ? 'smpte170m' : 'bt709', transfer: matrix === 601 ? 'smpte170m' : 'bt709', matrix: matrix === 601 ? 'smpte170m' : 'bt709', fullRange: false };

    const gray = new Uint8Array(((width + 1) >> 1) * ((height + 1) >> 1)).fill(128);

    let ms = 0;

    const starts = [];

    for (let i = 0; i < count; i++) {

        render(i, cv);

        if (cv.width !== width || cv.height !== height) throw new Error(`Il fotogramma ${i + 1} e' ${cv.width}×${cv.height}, non ${width}×${height}.`);

        const rgba = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;

        const p = rgbaToI420(rgba, width, height, matrix);

        const key = i % keyEvery === 0;

        const us = ms * 1000;

        const dur = Math.max(1, Math.round(durations[i]));

        const f1 = i420Frame(p.Y, p.U, p.V, width, height, us, dur * 1000, colorSpace);
        const f2 = i420Frame(p.A, gray, gray, width, height, us, dur * 1000, colorSpace);

        color.encode(f1, key);
        alpha.encode(f2, key);

        f1.close();
        f2.close();

        starts.push(ms);

        ms += dur;

        // non accumulare fotogrammi in coda
        while (color.queue() > 6 || alpha.queue() > 6) await sleep(2);

        if (onProgress) await onProgress(i + 1, count);
    }

    const [cc, ac] = await Promise.all([color.finish(), alpha.finish()]);

    if (cc.length !== count || ac.length !== count) {

        throw new Error(`Il codificatore ha dato ${cc.length}/${ac.length} fotogrammi su ${count}.`);
    }

    const frames = cc.map((c, i) => ({ ms: starts[i], dur: Math.max(1, Math.round(durations[i])), key: c.key, color: c.data, alpha: ac[i].data }));

    return { blob: muxWebm({ width, height, frames, hasAlpha: true, matrix }), frames: count, ms };
}


// ------------------------------------------------------------
// LETTURA DI UN WEBM GIA' FATTO (controllo del file vero)
// ------------------------------------------------------------

/*
    Legge i byte del file e ritorna: misure, codec, se ha la traccia di trasparenza (AlphaMode e
    flusso alfa in ogni fotogramma), quanti fotogrammi, durata di ognuno e durata totale.
*/
export function inspectWebm(u) {

    const MASTER = new Set([0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0xE0, 0x1F43B675, 0xA0, 0x75A1, 0xA6, 0x55B0]);

    const out = { codec: '', width: 0, height: 0, alphaMode: 0, frames: 0, alphaFrames: 0, durations: [], starts: [], durationMs: 0, matrix: 0, bytes: u.length };

    const readId = (p) => {

        const b = u[p];

        let len = 1;

        for (let m = 0x80; m && !(b & m); m >>= 1) len++;

        let id = 0;

        for (let i = 0; i < len; i++) id = id * 256 + u[p + i];

        return { id, len };
    };

    const readSize = (p) => {

        const b = u[p];

        let len = 1;

        for (let m = 0x80; m && !(b & m); m >>= 1) len++;

        let v = b & (0xFF >> len);

        for (let i = 1; i < len; i++) v = v * 256 + u[p + i];

        return { size: v, len };
    };

    const num = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u[p + i]; return v; };

    let clusterStart = 0;

    const walk = (p, end) => {

        while (p < end) {

            const { id, len } = readId(p);
            const { size, len: sl } = readSize(p + len);

            const body = p + len + sl;

            if (MASTER.has(id)) {

                if (id === 0x1F43B675) clusterStart = 0;

                walk(body, Math.min(end, body + size));

            } else if (id === 0x86) out.codec = String.fromCharCode(...u.subarray(body, body + size));
            else if (id === 0xB0) out.width = num(body, size);
            else if (id === 0xBA) out.height = num(body, size);
            else if (id === 0x53C0) out.alphaMode = num(body, size);
            else if (id === 0x55B1) out.matrix = num(body, size);
            else if (id === 0x4489) out.durationMs = size === 8 ? new DataView(u.buffer, u.byteOffset + body, 8).getFloat64(0) : new DataView(u.buffer, u.byteOffset + body, 4).getFloat32(0);
            else if (id === 0xE7) clusterStart = num(body, size);
            else if (id === 0xA1) {

                // numero traccia (vint) + tempo relativo (int16) + flag
                const tn = readSize(body);

                const rel = (u[body + tn.len] << 8) | u[body + tn.len + 1];

                out.frames++;
                out.starts.push(clusterStart + (rel > 32767 ? rel - 65536 : rel));

            } else if (id === 0x9B) out.durations.push(num(body, size));
            else if (id === 0xA5) out.alphaFrames++;

            p = body + size;
        }
    };

    walk(0, u.length);

    return out;
}
