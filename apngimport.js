// ============================================================
// IMPORTAZIONE DI ANIMAZIONI APNG
//
// Per le unita' che non hanno ne' CGG ne' CGS ne' .sam ma solo le
// animazioni gia' montate (APNG: idle, atk, move).
//
// 1. decodeApng()     legge i fotogrammi (con le regole APNG di sovrapposizione
//                     e pulizia: dispose / blend) e li ritaglia sul disegno.
// 2. buildApngUnit()  li trasforma in un'unita' come quelle del CGG: un solo
//                     "foglio" (atlante) con tutti i disegni, una riga per
//                     disegno e le sequenze idle / atk / move con i tempi veri.
// 3. expandLinks() / fetchApngs()  scaricano gli APNG da un link.
// ============================================================

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

// indirizzo degli APNG della libreria (serve solo quando si scrive il numero dell'unita')
export const APNG_BASE = 'https://library.bravefrontier.jp/bf1_rsc/unit/apng/';

const ANIMS = ['idle', 'atk', 'move'];

/*
    Fotogrammi della libreria (640x400): il personaggio sta sempre nello stesso punto (il centro dell'ombra e'
    in 440,280) e in basso a sinistra c'e' il logo con la scritta (x 10-160, y 302-389). Misurato su un APNG vero.
    feet = punto dei piedi dal centro in basso del fotogramma; cuts = rettangolo dal basso a sinistra.
*/
export const APNG_LIBRARY = {
    w: 640,
    h: 400,
    feet: { dx: 120, dy: -120 },
    cuts: [{ l: 8, b: 8, w: 160, h: 96 }]
};

// ---- CRC32 (serve per costruire i PNG dei singoli fotogrammi)
const CRC_TABLE = (() => {

    const t = new Uint32Array(256);

    for (let n = 0; n < 256; n++) {

        let c = n;

        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

        t[n] = c >>> 0;
    }

    return t;
})();

function crc32(bytes) {

    let c = 0xffffffff;

    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);

    return (c ^ 0xffffffff) >>> 0;
}

function hasSignature(b) {

    if (b.length < 8) return false;

    for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return false;

    return true;
}

const typeAt = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

function readChunks(b) {

    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

    const out = [];

    let p = 8;

    while (p + 12 <= b.length) {

        const len = dv.getUint32(p);

        if (p + 12 + len > b.length) break;

        const type = typeAt(b, p + 4);

        out.push({ type, data: b.subarray(p + 8, p + 8 + len) });

        p += 12 + len;

        if (type === 'IEND') break;
    }

    return out;
}

function makeChunk(type, data) {

    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);

    dv.setUint32(0, data.length);

    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);

    out.set(data, 8);

    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

    return out;
}

function joinBytes(list) {

    let n = 0;

    for (const a of list) n += a.length;

    const out = new Uint8Array(n);

    let p = 0;

    for (const a of list) { out.set(a, p); p += a.length; }

    return out;
}

// true se e' un PNG animato (c'e' il blocco acTL prima dei dati dell'immagine)
export function isApng(buffer) {

    const b = new Uint8Array(buffer);

    if (!hasSignature(b)) return false;

    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

    let p = 8;

    while (p + 12 <= b.length) {

        const len = dv.getUint32(p);

        const type = typeAt(b, p + 4);

        if (type === 'acTL') return true;

        if (type === 'IDAT' || type === 'IEND') return false;

        p += 12 + len;
    }

    return false;
}

async function toBitmap(png) {

    const blob = new Blob([png], { type: 'image/png' });

    // dati grezzi del file, senza correzioni di colore del browser
    try {

        return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

    } catch (e) { /* browser senza queste opzioni: si usa il modo normale */ }

    return await new Promise((ok, ko) => {

        const url = URL.createObjectURL(blob);

        const img = new Image();

        img.onload = () => { URL.revokeObjectURL(url); ok(img); };
        img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('immagine non leggibile')); };

        img.src = url;
    });
}

// parte del fotogramma dove c'e' qualcosa (alfa > 0): {bx, by, bw, bh, data} oppure null se e' vuoto
function trimFrame(img, W, H) {

    const d = img.data;

    let x0 = W, y0 = H, x1 = -1, y1 = -1;

    for (let y = 0; y < H; y++) {

        const row = y * W * 4;

        for (let x = 0; x < W; x++) {

            if (d[row + x * 4 + 3] === 0) continue;

            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }

    if (x1 < 0) return null;

    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

    const out = new Uint8ClampedArray(bw * bh * 4);

    for (let y = 0; y < bh; y++) {

        const s = ((y0 + y) * W + x0) * 4;

        out.set(d.subarray(s, s + bw * 4), y * bw * 4);
    }

    return { bx: x0, by: y0, bw, bh, data: out };
}

// toglie dal fotogramma i rettangoli indicati (misurati dall'angolo in basso a sinistra del fotogramma intero)
function clearRects(img, W, H, cuts) {

    if (!cuts || !cuts.length) return;

    const d = img.data;

    for (const c of cuts) {

        const x0 = Math.max(0, Math.floor(c.l)), x1 = Math.min(W, Math.ceil(c.l + c.w));
        const y0 = Math.max(0, Math.floor(H - c.b - c.h)), y1 = Math.min(H, Math.ceil(H - c.b));

        for (let y = y0; y < y1; y++) {

            const row = y * W * 4;

            for (let x = x0; x < x1; x++) d.fill(0, row + x * 4, row + x * 4 + 4);
        }
    }
}

/*
    Legge un PNG animato (o un PNG normale: un solo fotogramma).
    "cuts": rettangoli da togliere da ogni fotogramma (per esempio il logo): [{ l, b, w, h }] misurati
    dall'angolo in basso a sinistra del fotogramma intero (l = da sinistra, b = dal basso).
    Ritorna { width, height, animated, frames: [{ bx, by, bw, bh, data | null, delay }] }
    dove "delay" e' in millisecondi e "data" sono i pixel RGBA del ritaglio (null = fotogramma vuoto).
*/
export async function decodeApng(buffer, onProgress, cuts = []) {

    const bytes = new Uint8Array(buffer);

    if (!hasSignature(bytes)) throw new Error('non e\' un file PNG');

    const ch = readChunks(bytes);

    const ihdr = ch.find(c => c.type === 'IHDR');

    if (!ihdr || ihdr.data.length < 13) throw new Error('PNG danneggiato (manca l\'intestazione)');

    const idv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);

    const W = idv.getUint32(0), H = idv.getUint32(4);

    const depth = ihdr.data[8], colorType = ihdr.data[9], interlace = ihdr.data[12];

    if (!W || !H || W * H > 64e6) throw new Error(`misure non valide (${W}×${H})`);

    const plte = ch.find(c => c.type === 'PLTE');
    const trns = ch.find(c => c.type === 'tRNS');

    const cv = document.createElement('canvas');

    cv.width = W;
    cv.height = H;

    const ctx = cv.getContext('2d', { willReadFrequently: true });

    ctx.imageSmoothingEnabled = false;

    // i rettangoli possono dipendere dalla misura del fotogramma
    if (typeof cuts === 'function') cuts = cuts(W, H);

    const frames = [];

    // ---- PNG normale: un fotogramma solo
    if (!ch.some(c => c.type === 'acTL')) {

        const bmp = await toBitmap(bytes);

        ctx.drawImage(bmp, 0, 0);

        if (bmp.close) bmp.close();

        const img0 = ctx.getImageData(0, 0, W, H);

        clearRects(img0, W, H, cuts);

        const t = trimFrame(img0, W, H);

        frames.push(t ? { ...t, delay: 100 } : { bx: 0, by: 0, bw: 0, bh: 0, data: null, delay: 100 });

        return { width: W, height: H, animated: false, frames };
    }

    // ---- APNG: i dati di ogni fotogramma
    const list = [];

    let cur = null;
    let idatOwner = null;
    let seenIdat = false;

    for (const c of ch) {

        if (c.type === 'fcTL') {

            if (c.data.length < 26) continue;

            const dv = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);

            cur = {
                w: dv.getUint32(4), h: dv.getUint32(8), x: dv.getUint32(12), y: dv.getUint32(16),
                dn: dv.getUint16(20), dd: dv.getUint16(22), dispose: c.data[24], blend: c.data[25],
                data: []
            };

            list.push(cur);

        } else if (c.type === 'IDAT') {

            // l'immagine "di riserva" (senza fcTL davanti) non fa parte dell'animazione
            if (!seenIdat) { seenIdat = true; idatOwner = cur; }

            if (idatOwner) idatOwner.data.push(c.data);

        } else if (c.type === 'fdAT' && cur && c.data.length > 4) {

            cur.data.push(c.data.subarray(4));
        }
    }

    if (!list.length) throw new Error('nessun fotogramma nell\'APNG');

    let n = 0;

    for (const f of list) {

        if (!f.data.length || !f.w || !f.h) throw new Error(`fotogramma ${n + 1} senza dati`);

        const head = new Uint8Array(13);
        const hv = new DataView(head.buffer);

        hv.setUint32(0, f.w);
        hv.setUint32(4, f.h);

        head[8] = depth;
        head[9] = colorType;
        head[12] = interlace;

        const png = joinBytes([
            new Uint8Array(SIG),
            makeChunk('IHDR', head),
            plte ? makeChunk('PLTE', plte.data) : new Uint8Array(0),
            trns ? makeChunk('tRNS', trns.data) : new Uint8Array(0),
            makeChunk('IDAT', joinBytes(f.data)),
            makeChunk('IEND', new Uint8Array(0))
        ]);

        const bmp = await toBitmap(png);

        // dispose del fotogramma "prima": per il primo, "torna a come era" vale come "svuota"
        const dispose = (n === 0 && f.dispose === 2) ? 1 : f.dispose;

        const saved = dispose === 2 ? ctx.getImageData(f.x, f.y, f.w, f.h) : null;

        // blend 0 = al posto di cio' che c'e'; 1 = sopra
        if (f.blend === 0) ctx.clearRect(f.x, f.y, f.w, f.h);

        ctx.drawImage(bmp, f.x, f.y);

        if (bmp.close) bmp.close();

        // il fotogramma come lo si vede (senza i rettangoli tolti); la tela sotto resta intera per i fotogrammi dopo
        const shown = ctx.getImageData(0, 0, W, H);

        clearRects(shown, W, H, cuts);

        const t = trimFrame(shown, W, H);

        const ms = (f.dn / (f.dd || 100)) * 1000;

        frames.push({ ...(t || { bx: 0, by: 0, bw: 0, bh: 0, data: null }), delay: ms > 0 ? ms : 0 });

        // pulizia dopo che il fotogramma e' stato mostrato
        if (dispose === 1) ctx.clearRect(f.x, f.y, f.w, f.h);
        else if (dispose === 2 && saved) ctx.putImageData(saved, f.x, f.y);

        n++;

        if (onProgress) onProgress(n, list.length);
    }

    return { width: W, height: H, animated: true, frames };
}


// ------------------------------------------------------------
// DA FOTOGRAMMI A UNITA'
// ------------------------------------------------------------

function hashBytes(a) {

    let h = 2166136261;

    for (let i = 0; i < a.length; i += 4) {

        h = Math.imul(h ^ a[i], 16777619);
        h = Math.imul(h ^ a[i + 1], 16777619);
        h = Math.imul(h ^ a[i + 2], 16777619);
        h = Math.imul(h ^ a[i + 3], 16777619);
    }

    return h >>> 0;
}

function sameBytes(a, b) {

    if (a.length !== b.length) return false;

    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;

    return true;
}

/*
    anims: [{ name: 'idle' | 'atk' | 'move', dec: risultato di decodeApng }]
    Ritorna { atlas, framesDB, sequences, order, sizes, cellCount } nello stesso formato del CGG / CGS:
    framesDB[riga] = [pezzo] e sequences[nome] = [{ id, xOffset, yOffset, duration (in 1/60 s) }].

    Ogni disegno diverso e' un ritaglio del foglio. I fotogrammi tutti uguali condividono la stessa riga
    (e lo stesso ritaglio). Il punto 0,0 dell'animatore e' il centro in basso del fotogramma: le animazioni
    della stessa unita' stanno cosi' una sull'altra anche se hanno misure diverse. "feet" sposta quel punto
    (di dx, dy dal centro in basso) sui piedi del personaggio.
*/
export function buildApngUnit(anims, tickMs = 1000 / 60, feet = { dx: 0, dy: 0 }) {

    const cells = [];
    const byHash = new Map();

    const framesDB = [];
    const rowIndex = new Map();
    const sequences = {};
    const sizes = {};
    const anchors = {};
    const order = [];

    const cellFor = (f) => {

        const key = f.bw + 'x' + f.bh + ':' + hashBytes(f.data);

        let list = byHash.get(key);

        if (!list) byHash.set(key, list = []);

        for (const c of list) if (sameBytes(c.data, f.data)) return c;

        const c = { id: cells.length, w: f.bw, h: f.bh, data: f.data, sx: 0, sy: 0 };

        cells.push(c);
        list.push(c);

        return c;
    };

    for (const { name, dec } of anims) {

        // punto dei piedi del personaggio nel fotogramma, misurato dal centro in basso (dx, dy): diventa lo 0,0 dell'animatore
        const ft = typeof feet === 'function' ? feet(dec.width, dec.height) : feet;

        const ax = Math.round(dec.width / 2 + (Number(ft && ft.dx) || 0)), ay = Math.round(dec.height + (Number(ft && ft.dy) || 0));

        anchors[name] = { x: ax, y: ay };

        sizes[name] = { w: dec.width, h: dec.height, animated: dec.animated, frames: dec.frames.length };

        const seq = [];

        for (const f of dec.frames) {

            let key = 'vuoto';
            let cell = null;

            if (f.data) {

                cell = cellFor(f);

                key = cell.id + '@' + (f.bx - ax) + ',' + (f.by - ay);
            }

            let id = rowIndex.get(key);

            if (id === undefined) {

                id = framesDB.length;

                rowIndex.set(key, id);

                framesDB.push(cell
                    ? [{
                        x: f.bx - ax, y: f.by - ay, flipType: 0, blendMode: 0, opacity: 100, rotate: 0,
                        sx: 0, sy: 0, w: cell.w, h: cell.h, pageId: 0, _cell: cell
                    }]
                    : []);
            }

            seq.push({ id, xOffset: 0, yOffset: 0, duration: Math.max(1, Math.round(f.delay / tickMs)) });
        }

        sequences[name] = seq;
        order.push(name);
    }

    if (!cells.length) throw new Error('tutti i fotogrammi sono vuoti (completamente trasparenti)');

    // ---- foglio: i ritagli uno accanto all'altro, con 1 pixel di margine trasparente
    const GAP = 1;

    let area = 0, widest = 0;

    for (const c of cells) { area += (c.w + GAP) * (c.h + GAP); widest = Math.max(widest, c.w + GAP); }

    const width = Math.min(8192, Math.max(widest, 1024, Math.ceil(Math.sqrt(area) * 1.25)));

    let x = 0, y = 0, rowH = 0;

    for (const c of cells) {

        if (x + c.w + GAP > width) { x = 0; y += rowH + GAP; rowH = 0; }

        c.sx = x;
        c.sy = y;

        x += c.w + GAP;

        rowH = Math.max(rowH, c.h);
    }

    const height = y + rowH + GAP;

    if (width > 16384 || height > 16384 || width * height > 200e6) throw new Error('troppi fotogrammi: il foglio verrebbe enorme');

    const atlas = document.createElement('canvas');

    atlas.width = width;
    atlas.height = height;

    const actx = atlas.getContext('2d');

    for (const c of cells) actx.putImageData(new ImageData(c.data, c.w, c.h), c.sx, c.sy);

    for (const row of framesDB) {

        for (const p of row) {

            p.sx = p._cell.sx;
            p.sy = p._cell.sy;

            delete p._cell;
        }
    }

    return { atlas, framesDB, sequences, order, sizes, anchors, cellCount: cells.length };
}


// ------------------------------------------------------------
// DEFAULT: un solo APNG con tutta l'animazione
//
// Dentro ci sono, uno dopo l'altro: l'idle (un giro ripetuto 2 volte o piu'), poi - se l'unita' ce l'ha -
// il move (lo scatto in avanti), poi l'attacco fino alla fine. Qui si trovano i tagli e si divide.
// ------------------------------------------------------------

function sameFrame(a, b) {

    if (!a || !b) return false;

    if (a.delay !== b.delay || a.bx !== b.bx || a.by !== b.by || a.bw !== b.bw || a.bh !== b.bh) return false;

    if (!a.data || !b.data) return !a.data && !b.data;

    return sameBytes(a.data, b.data);
}

/*
    Indovina i tagli di un default decodificato (decodeApng):
    - idle = il blocco di fotogrammi con cui il default comincia e che si ripete subito dopo
             (idleLen fotogrammi, ripetuto idleReps volte);
    - move = i fotogrammi subito dopo l'idle in cui il personaggio e' spostato in basso rispetto all'idle
             (lo scatto in avanti); se non ce ne sono, l'unita' non ha il move;
    - atk  = tutto il resto, fino alla fine.
    Ritorna { idleLen, idleReps, moveLen, repeated (l'idle si ripete davvero), moveGuessed }.
*/
export function guessDefaultSplit(dec) {

    const fr = dec.frames;
    const n = fr.length;

    const blockEq = (a, b, p) => {

        for (let i = 0; i < p; i++) if (!sameFrame(fr[a + i], fr[b + i])) return false;

        return true;
    };

    let best = null;

    for (let p = 1; p * 2 <= n; p++) {

        let reps = 1;

        while ((reps + 1) * p <= n && blockEq(0, reps * p, p)) reps++;

        // vince il blocco che copre piu' fotogrammi; a parita' il piu' corto
        if (reps >= 2 && (!best || reps * p > best.idleLen * best.idleReps)) best = { idleLen: p, idleReps: reps };
    }

    let split;

    if (best) {

        split = { idleLen: best.idleLen, idleReps: best.idleReps, moveLen: 0, repeated: true, moveGuessed: false };

    } else {

        // l'idle non si ripete: prendo i primi fotogrammi con la stessa durata
        let run = 1;

        while (run < n && fr[run].delay === fr[0].delay) run++;

        split = { idleLen: Math.max(1, Math.min(run, n - 1 || 1)), idleReps: 1, moveLen: 0, repeated: false, moveGuessed: false };
    }

    // lo scatto in avanti: dopo l'idle il personaggio sta piu' in basso di almeno 8 pixel
    const bottom = (f) => (f && f.data ? f.by + f.bh : null);

    const idleBottoms = fr.slice(0, split.idleLen).map(bottom).filter(v => v !== null);

    const start = split.idleLen * split.idleReps;

    if (idleBottoms.length) {

        const ref = Math.max(...idleBottoms);

        let k = 0;

        while (start + k < n - 1 && k < 6 && bottom(fr[start + k]) !== null && bottom(fr[start + k]) >= ref + 8) k++;

        if (k > 0) {

            split.moveLen = k;
            split.moveGuessed = true;
        }
    }

    return split;
}

// tagli validi per un default di n fotogrammi
export function clampSplit(s, n) {

    const int = (v, d) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);

    const idleLen = Math.max(1, Math.min(n, int(s && s.idleLen, 1)));

    let idleReps = Math.max(1, int(s && s.idleReps, 1));

    while (idleLen * idleReps > n) idleReps--;

    const moveLen = Math.max(0, Math.min(n - idleLen * idleReps, int(s && s.moveLen, 0)));

    return { idleLen, idleReps, moveLen };
}

// divide il default: { idle, move, atk } come APNG decodificati (null se non ce ne sono)
export function sliceDefault(dec, split) {

    const fr = dec.frames;

    const block = split.idleLen * split.idleReps;

    const moveEnd = block + split.moveLen;

    const part = (a, b) => (b > a ? { ...dec, animated: true, frames: fr.slice(a, b) } : null);

    return { idle: part(0, split.idleLen), move: part(block, moveEnd), atk: part(moveEnd, fr.length) };
}


// ------------------------------------------------------------
// NOMI E LINK
// ------------------------------------------------------------

// "10323_idle.png" -> 'idle'; "10323_default.png" -> 'default'; null se il nome non dice quale animazione e'
export function animFromName(name) {

    const n = String(name || '').toLowerCase().replace(/\.[a-z0-9]+$/, '');

    if (/(^|[^a-z])idle([^a-z]|$)/.test(n)) return 'idle';
    if (/(^|[^a-z])(atk|attack)([^a-z]|$)/.test(n)) return 'atk';
    if (/(^|[^a-z])(move|walk)([^a-z]|$)/.test(n)) return 'move';

    // l'animazione completa: idle ripetuto + (move) + atk in un solo APNG
    if (/(^|[^a-z])(default|full)([^a-z]|$)/.test(n)) return 'default';

    return null;
}

// numero dell'unita' dai nomi dei file ("10323_idle.png" -> "10323")
export function unitIdFromNames(names) {

    for (const n of names) {

        const m = /(^|[^0-9])(\d{3,})([^0-9]|$)/.exec(String(n));

        if (m) return m[2];
    }

    return '';
}

/*
    Cosa si scrive nella casella dei link:
    - il solo numero dell'unita' (10323): idle, atk e move dall'indirizzo della libreria;
    - un indirizzo intero: si prova anche con gli altri due (…_idle.png -> …_atk.png, …_move.png);
    - piu' indirizzi (uno per riga): si usano proprio quelli.
*/
export function expandLinks(text) {

    const tokens = String(text || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

    const out = [];

    const add = (url, optional = false) => { if (!out.some(o => o.url === url)) out.push({ url, optional, name: decodeURIComponent(url.split('?')[0].split('/').pop() || 'file.png') }); };

    for (const t of tokens) {

        if (/^\d{3,}$/.test(t)) {

            for (const a of ANIMS) add(`${APNG_BASE}${t}/${t}_${a}.png`);

            // il default completo (se esiste serve per le animazioni che mancano; se non esiste non e' un errore)
            add(`${APNG_BASE}${t}/${t}_default.png`, true);

        } else if (/^https?:\/\//i.test(t)) {

            const m = /^(.*)_(idle|atk|move|default)(\.png)(\?.*)?$/i.exec(t);

            if (m && tokens.length === 1) {

                for (const a of ANIMS) add(`${m[1]}_${a}${m[3]}${m[4] || ''}`);

                add(`${m[1]}_default${m[3]}${m[4] || ''}`, m[2].toLowerCase() !== 'default');

            } else {

                add(t);
            }
        }
    }

    return out;
}

// la casella "servizio esterno" va lasciata vuota; se ci hanno incollato il link dell'immagine non e' un servizio
export function proxyLooksWrong(proxy) {

    const t = String(proxy || '').trim();

    if (!t) return false;

    return /\.(png|apng|jpe?g|gif|webp)(\?.*)?$/i.test(t) || /bravefrontier/i.test(t);
}

/*
    Scarica gli APNG. Ritorna { files: [File], failed: [{ url, why, blocked, unreachable }] }.
    Il browser puo' leggere un file di un altro sito solo se quel sito lo permette (CORS):
    se non lo permette si scarica il file a mano e lo si trascina nella pagina.
    "proxy" (facoltativo): testo da mettere davanti all'indirizzo (l'indirizzo viene codificato).
*/
export async function fetchApngs(items, proxy = '', onStatus = null) {

    const files = [];
    const failed = [];

    await Promise.all(items.map(async (it) => {

        const target = proxy ? proxy + encodeURIComponent(it.url) : it.url;

        try {

            const res = await fetch(target, { mode: 'cors', cache: 'no-store' });

            if (!res.ok) {

                failed.push({ url: it.url, why: res.status === 404 ? 'non esiste (404)' : `errore del sito (${res.status})`, status: res.status });

                return;
            }

            const buf = await res.arrayBuffer();

            if (!hasSignature(new Uint8Array(buf))) {

                failed.push({ url: it.url, why: 'il file scaricato non e\' un PNG' });

                return;
            }

            files.push(new File([buf], it.name, { type: 'image/png' }));

            if (onStatus) onStatus(it, true);

        } catch (e) {

            // il browser non dice perche': provo una richiesta "cieca" (senza leggere la risposta).
            // Se arriva, il sito c'e' ma non permette di leggere i file da un'altra pagina (blocco CORS).
            let reachable = false;

            try {

                await fetch(target, { mode: 'no-cors', cache: 'no-store' });

                reachable = true;

            } catch (e2) { /* non raggiungibile */ }

            failed.push(reachable
                ? { url: it.url, why: 'il sito risponde ma non permette ad altre pagine di leggere i suoi file (blocco CORS)', blocked: true }
                : { url: it.url, why: 'il sito non risponde (indirizzo sbagliato, rete assente o sito che blocca la richiesta)', unreachable: true });
        }
    }));

    // stesso ordine dell'elenco
    files.sort((a, b) => items.findIndex(i => i.name === a.name) - items.findIndex(i => i.name === b.name));

    return { files, failed };
}