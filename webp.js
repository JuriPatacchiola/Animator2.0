// ============================================================
// Encoder WebP ANIMATO - nessuna dipendenza
//
// Ogni fotogramma e' un WebP statico creato dal browser
// (canvas.toBlob('image/webp')); qui i fotogrammi vengono
// impacchettati in un unico file animato (RIFF: VP8X + ANIM + ANMF).
// Le durate sono in millisecondi esatti (la GIF arriva solo ai 10 ms).
// ============================================================

const tag = (s) => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];

const le16 = (n) => [n & 255, (n >>> 8) & 255];
const le24 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

const readTag = (u, p) => String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
const read24 = (u, p) => u[p] | (u[p + 1] << 8) | (u[p + 2] << 16);
const read32 = (u, p) => (u[p] | (u[p + 1] << 8) | (u[p + 2] << 16) | (u[p + 3] << 24)) >>> 0;

// un chunk RIFF: tipo + lunghezza + dati (+ 1 byte di riempimento se dispari)
function chunk(type, data) {

    const pad = data.length & 1;

    const out = new Uint8Array(8 + data.length + pad);

    out.set(tag(type), 0);
    out.set(le32(data.length), 4);
    out.set(data, 8);

    return out;
}

function concat(parts) {

    let n = 0;

    for (const p of parts) n += p.length;

    const out = new Uint8Array(n);

    let o = 0;

    for (const p of parts) { out.set(p, o); o += p.length; }

    return out;
}

/*
    Legge un WebP statico e ne estrae i dati dell'immagine (ALPH + VP8 / VP8L),
    senza profili colore (ICCP) ne' metadati: quelli non servono dentro un fotogramma.
    Restituisce { data, width, height, alpha } oppure lancia un errore.
*/
export function parseStillWebp(u) {

    if (u.length < 20 || readTag(u, 0) !== 'RIFF' || readTag(u, 8) !== 'WEBP') {

        throw new Error('Il browser non ha creato un WebP valido (usa Chrome o Edge).');
    }

    const keep = [];

    let width = 0, height = 0, alpha = false, image = false;

    let p = 12;

    while (p + 8 <= u.length) {

        const type = readTag(u, p);

        const size = read32(u, p + 4);

        const body = u.subarray(p + 8, p + 8 + size);

        if (p + 8 + size > u.length) throw new Error('WebP incompleto.');

        if (type === 'VP8X') {

            alpha = (body[0] & 0x10) !== 0;
            width = read24(body, 4) + 1;
            height = read24(body, 7) + 1;

        } else if (type === 'ALPH') {

            alpha = true;
            keep.push(chunk('ALPH', body));

        } else if (type === 'VP8 ') {

            image = true;

            if (!width) {

                width = (body[6] | (body[7] << 8)) & 0x3fff;
                height = (body[8] | (body[9] << 8)) & 0x3fff;
            }

            keep.push(chunk('VP8 ', body));

        } else if (type === 'VP8L') {

            image = true;

            if (!width) {

                const b = body[1] | (body[2] << 8) | (body[3] << 16) | (body[4] << 24);

                width = (b & 0x3fff) + 1;
                height = ((b >>> 14) & 0x3fff) + 1;
                alpha = ((b >>> 28) & 1) === 1;
            }

            keep.push(chunk('VP8L', body));
        }

        p += 8 + size + (size & 1);
    }

    if (!image || !width || !height) throw new Error('WebP senza immagine.');

    return { data: concat(keep), width, height, alpha };
}

/*
    width, height: misure della tela (tutta l'animazione).
    hasAlpha: true se lo sfondo e' trasparente / semitrasparente.
    loop: 0 = all'infinito.

    Ogni fotogramma puo' essere solo una PARTE della tela (x, y, larghezza,
    altezza del suo WebP): sostituisce quei pixel e lascia tutto il resto
    com'era (niente fusione con il fotogramma prima, niente "pulizia").
    E' il trucco dei WebP piccoli: si salva solo cio' che cambia.
*/
export function createWebpWriter(width, height, { loop = 0, hasAlpha = true } = {}) {

    if (width < 1 || height < 1 || width > 16383 || height > 16383) {

        throw new Error(`Misure non valide per un WebP (${width}×${height}, massimo 16383).`);
    }

    const frames = [];

    const buildFrame = (f) => {

        // X, Y (nel file a multipli di 2), larghezza-1, altezza-1, durata, flag:
        // bit1 = niente fusione con il fotogramma prima, bit0 = niente "pulizia" (il fotogramma dopo parte da qui)
        const head = new Uint8Array([
            ...le24(f.x >> 1), ...le24(f.y >> 1), ...le24(f.w - 1), ...le24(f.h - 1), ...le24(f.dur), 0x02
        ]);

        return chunk('ANMF', concat([head, f.data]));
    };

    return {

        // bytes = file WebP statico del fotogramma; ms = quanto resta sullo schermo;
        // x, y = dove va sulla tela (numeri pari)
        addFrame(bytes, ms, x = 0, y = 0) {

            const f = parseStillWebp(bytes);

            if ((x & 1) || (y & 1)) {

                throw new Error(`La posizione del fotogramma (${x}, ${y}) deve essere pari.`);
            }

            if (x + f.width > width || y + f.height > height) {

                throw new Error(`Il fotogramma ${f.width}×${f.height} in (${x}, ${y}) esce dalla tela ${width}×${height}.`);
            }

            if (!frames.length && (x !== 0 || y !== 0 || f.width !== width || f.height !== height)) {

                throw new Error('Il primo fotogramma deve coprire tutta la tela.');
            }

            frames.push({ x, y, w: f.width, h: f.height, dur: Math.max(1, Math.min(0xffffff, Math.round(ms))), data: f.data });
        },

        // il fotogramma appena aggiunto resta sullo schermo ancora per "ms"
        extendLast(ms) {

            if (!frames.length) return;

            const f = frames[frames.length - 1];

            f.dur = Math.max(1, Math.min(0xffffff, f.dur + Math.round(ms)));
        },

        get count() { return frames.length; },

        finish() {

            if (!frames.length) throw new Error('Nessun fotogramma da salvare.');

            const vp8x = chunk('VP8X', new Uint8Array([
                0x02 | (hasAlpha ? 0x10 : 0), 0, 0, 0, ...le24(width - 1), ...le24(height - 1)
            ]));

            // colore di sfondo (B, G, R, A) trasparente, poi quante volte ripetere
            const anim = chunk('ANIM', new Uint8Array([0, 0, 0, 0, ...le16(loop)]));

            const body = concat([new Uint8Array(tag('WEBP')), vp8x, anim, ...frames.map(buildFrame)]);

            const riff = concat([new Uint8Array(tag('RIFF')), new Uint8Array(le32(body.length)), body]);

            return new Blob([riff], { type: 'image/webp' });
        }
    };
}

/*
    Crea l'intero WebP animato.

    width, height: misure della tela; count: quanti fotogrammi; durations[i]: ms del fotogramma i;
    render(i, canvas): disegna il fotogramma i (a tutta tela) sul canvas;
    subRect: true = ogni fotogramma dopo il primo salva solo il rettangolo dei pixel cambiati
             (senza perdita; i fotogrammi identici al precedente si fondono in uno solo);
             false = ogni fotogramma e' intero.
    quality: 1 = senza perdita (VP8L), meno = con perdita.
*/
export async function encodeAnimatedWebp({
    width, height, count, durations, render,
    hasAlpha = true, quality = 1, subRect = true, loop = 0, onProgress = null
}) {

    const writer = createWebpWriter(width, height, { loop, hasAlpha });

    const cv = document.createElement('canvas');
    const sub = document.createElement('canvas');

    let prev = null;

    for (let i = 0; i < count; i++) {

        render(i, cv);

        if (cv.width !== width || cv.height !== height) {

            throw new Error(`Il fotogramma ${i + 1} e' ${cv.width}×${cv.height}, non ${width}×${height}.`);
        }

        let x = 0, y = 0, w = width, h = height;

        if (subRect) {

            const px = new Uint32Array(
                cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data.buffer
            );

            if (prev) {

                let x0 = width, y0 = height, x1 = -1, y1 = -1;

                for (let yy = 0; yy < height; yy++) {

                    const row = yy * width;

                    for (let xx = 0; xx < width; xx++) {

                        if (px[row + xx] !== prev[row + xx]) {

                            if (xx < x0) x0 = xx;
                            if (xx > x1) x1 = xx;
                            if (yy < y0) y0 = yy;
                            if (yy > y1) y1 = yy;
                        }
                    }
                }

                // identico al precedente: resta sullo schermo piu' a lungo
                if (x1 < 0) {

                    writer.extendLast(durations[i]);

                    if (onProgress) await onProgress(i + 1, count);

                    continue;
                }

                // il WebP posiziona i fotogrammi a multipli di 2
                x = x0 & ~1;
                y = y0 & ~1;
                w = x1 - x + 1;
                h = y1 - y + 1;
            }

            prev = px;
        }

        let src = cv;

        if (w !== width || h !== height) {

            sub.width = w;
            sub.height = h;

            const sc = sub.getContext('2d');

            sc.clearRect(0, 0, w, h);
            sc.drawImage(cv, x, y, w, h, 0, 0, w, h);

            src = sub;
        }

        const blob = await new Promise(resolve => src.toBlob(resolve, 'image/webp', quality));

        if (!blob || blob.type !== 'image/webp') {

            throw new Error('Questo browser non sa creare immagini WebP: usa Chrome o Edge.');
        }

        writer.addFrame(new Uint8Array(await blob.arrayBuffer()), durations[i], x, y);

        if (onProgress) await onProgress(i + 1, count);
    }

    return { blob: writer.finish(), frames: writer.count };
}

/*
    Legge un WebP animato GIA' FATTO (i byte del file, non i fotogrammi che lo hanno creato) e dice com'e':
    misure della tela, quanti fotogrammi, durata di ognuno, ripetizioni, trasparenza, senza perdita.
*/
export function inspectWebp(u) {

    if (u.length < 20 || readTag(u, 0) !== 'RIFF' || readTag(u, 8) !== 'WEBP') throw new Error('Non e\' un WebP.');

    const out = { width: 0, height: 0, animated: false, alpha: false, loop: null, frames: 0, durations: [], lossless: true, lossy: false, bytes: u.length };

    let p = 12;

    while (p + 8 <= u.length) {

        const type = readTag(u, p);
        const size = read32(u, p + 4);
        const body = u.subarray(p + 8, p + 8 + size);

        if (type === 'VP8X') {

            out.animated = (body[0] & 0x02) !== 0;
            out.alpha = (body[0] & 0x10) !== 0;
            out.width = read24(body, 4) + 1;
            out.height = read24(body, 7) + 1;

        } else if (type === 'ANIM') {

            out.loop = body[4] | (body[5] << 8);

        } else if (type === 'ANMF') {

            out.frames++;
            out.durations.push(read24(body, 12));

            // sotto-chunk del fotogramma (dopo i 16 byte di intestazione)
            let q = 16;

            while (q + 8 <= body.length) {

                const t = readTag(body, q);

                if (t === 'VP8 ') { out.lossless = false; out.lossy = true; }

                q += 8 + read32(body, q + 4) + (read32(body, q + 4) & 1);
            }
        }

        p += 8 + size + (size & 1);
    }

    return out;
}