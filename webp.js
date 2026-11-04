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
    width, height: misure del fotogramma (tutti uguali).
    hasAlpha: true se lo sfondo e' trasparente / semitrasparente.
    loop: 0 = all'infinito.
*/
export function createWebpWriter(width, height, { loop = 0, hasAlpha = true } = {}) {

    if (width < 1 || height < 1 || width > 16383 || height > 16383) {

        throw new Error(`Misure non valide per un WebP (${width}×${height}, massimo 16383).`);
    }

    const frames = [];

    return {

        // bytes = file WebP statico del fotogramma; ms = quanto resta sullo schermo
        addFrame(bytes, ms) {

            const f = parseStillWebp(bytes);

            if (f.width !== width || f.height !== height) {

                throw new Error(`Il fotogramma ${f.width}×${f.height} non ha le misure del WebP (${width}×${height}).`);
            }

            const dur = Math.max(1, Math.min(0xffffff, Math.round(ms)));

            // X, Y (a multipli di 2), larghezza-1, altezza-1, durata, flag:
            // bit1 = niente fusione con il fotogramma prima, bit0 = niente "pulizia" (ogni fotogramma e' pieno)
            const head = new Uint8Array([
                ...le24(0), ...le24(0), ...le24(width - 1), ...le24(height - 1), ...le24(dur), 0x02
            ]);

            frames.push(chunk('ANMF', concat([head, f.data])));
        },

        get count() { return frames.length; },

        finish() {

            if (!frames.length) throw new Error('Nessun fotogramma da salvare.');

            const vp8x = chunk('VP8X', new Uint8Array([
                0x02 | (hasAlpha ? 0x10 : 0), 0, 0, 0, ...le24(width - 1), ...le24(height - 1)
            ]));

            // colore di sfondo (B, G, R, A) trasparente, poi quante volte ripetere
            const anim = chunk('ANIM', new Uint8Array([0, 0, 0, 0, ...le16(loop)]));

            const body = concat([new Uint8Array(tag('WEBP')), vp8x, anim, ...frames]);

            const riff = concat([new Uint8Array(tag('RIFF')), new Uint8Array(le32(body.length)), body]);

            return new Blob([riff], { type: 'image/webp' });
        }
    };
}
