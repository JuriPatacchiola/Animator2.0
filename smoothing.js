// ============================================================
// SMOOTHING
//
// Funzioni "pure" (nessun accesso a DOM o canvas) usate sia dal
// lettore sia dall'esportazione GIF, cosi' i due mostrano
// esattamente la stessa cosa.
// ============================================================

export const TICK_MS = 1000 / 60;      // 1 tick del CGS = 1/60 di secondo


// ------------------------------------------------------------
// UTILITA'
// ------------------------------------------------------------

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerpAngle(a, b, t) {

    let d = (b - a) % 360;

    if (d > 180) d -= 360;
    if (d < -180) d += 360;

    return a + d * t;
}

function opacityOf(p) {
    return Number.isFinite(p.opacity) ? p.opacity : 100;
}

/*
    Due pezzi sono "lo stesso pezzo" se ritagliano lo stesso
    rettangolo dello sheet con gli stessi flip / blend.
*/

export function pieceKey(p) {

    return [
        p.sx, p.sy, p.w, p.h,
        p.pageId, p.flipType, p.blendMode
    ].join(',');
}


// ------------------------------------------------------------
// BLOCCO A TERRA
//
// L'ultimo pezzo di ogni riga del CGG e' l'ombra (un'ellisse piu'
// larga che alta, sempre la stessa o quasi). Se i frame la
// spostano, il personaggio sembra scivolare di lato: calcolo di
// quanto spostare ogni frame per tenere l'ombra ferma dove sta
// nel primo frame.
//
// Restituisce un array {x, y} per ogni riga del CGG.
// ------------------------------------------------------------

export function computeGroundShifts(framesDB) {

    const none = framesDB.map(() => ({ x: 0, y: 0 }));

    if (framesDB.length < 2) return none;

    const count = new Map();

    for (const pieces of framesDB) {

        const last = pieces[pieces.length - 1];

        if (!last) continue;

        const key = pieceKey(last);

        count.set(key, (count.get(key) || 0) + 1);
    }

    const top = [...count.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2);

    const covered = top.reduce((sum, e) => sum + e[1], 0);

    // se non c'e' un'ombra riconoscibile non tocco niente
    if (covered / framesDB.length < 0.7 || top.some(e => e[1] < 2)) return none;

    const shadowKeys = new Set(top.map(e => e[0]));

    const anchors = framesDB.map(pieces => {

        const p = pieces[pieces.length - 1];

        if (!p || !shadowKeys.has(pieceKey(p)) || !(p.w > p.h)) return null;

        return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
    });

    const ref = anchors.find(a => a);

    if (!ref) return none;

    return anchors.map(a => a ? { x: ref.x - a.x, y: ref.y - a.y } : { x: 0, y: 0 });
}


// ------------------------------------------------------------
// SEQUENZE
// ------------------------------------------------------------

export function frameDuration(frame) {
    return Math.max(1, Number(frame.duration) || 1);
}

export function sequenceTotalTicks(sequence) {
    return sequence.reduce((sum, f) => sum + frameDuration(f), 0);
}

/*
    A che frame siamo dopo "tick" tick dall'inizio del loop?
    t = quanto e' avanzato dentro il frame (0..1).
*/

export function sampleSequence(sequence, tick) {

    let acc = 0;

    for (let i = 0; i < sequence.length; i++) {

        const d = frameDuration(sequence[i]);

        if (tick < acc + d) return { index: i, t: (tick - acc) / d };

        acc += d;
    }

    return { index: sequence.length - 1, t: 0 };
}


// ------------------------------------------------------------
// PEZZI DI UN FRAME
//
// I pezzi restituiti hanno gia' dentro l'offset del CGS e quello
// del blocco a terra: vanno disegnati con offset 0.
// ------------------------------------------------------------

function offsetFor(frame, shifts) {

    const s = shifts && shifts[frame.id] ? shifts[frame.id] : { x: 0, y: 0 };

    return {
        x: (Number(frame.xOffset) || 0) + s.x,
        y: (Number(frame.yOffset) || 0) + s.y
    };
}

function placed(pieces, off) {

    return pieces
        .filter(p => p && p.w > 0 && p.h > 0)
        .map((p, i) => ({ ...p, x: (Number(p.x) || 0) + off.x, y: (Number(p.y) || 0) + off.y }));
}

/*
    Passaggio morbido tra due frame (t da 0 a 1):

    - un pezzo presente in entrambi (stesso ritaglio) si muove, ruota e
      cambia opacita' in modo continuo;
    - un pezzo che compare o sparisce (forme del mantello, scie, ...)
      entra / esce con una dissolvenza;
    - il pezzo in primo piano (il corpo) non sfuma: cambia a meta' tempo,
      cosi' il personaggio non diventa mai trasparente.
*/

export function blendPieces(a, b, t, offA, offB, maxMove = 30) {

    const used = new Set();
    const out = [];

    const keysB = b.map(p => p ? pieceKey(p) : null);

    a.forEach((p, i) => {

        if (!p || !(p.w > 0) || !(p.h > 0)) return;

        const key = pieceKey(p);

        const ax = (Number(p.x) || 0) + offA.x;
        const ay = (Number(p.y) || 0) + offA.y;

        let found = -1;
        let best = Infinity;

        for (let m = 0; m < b.length; m++) {

            if (used.has(m) || keysB[m] !== key) continue;

            const d = Math.hypot(
                (Number(b[m].x) || 0) + offB.x - ax,
                (Number(b[m].y) || 0) + offB.y - ay
            );

            if (d < best) {
                best = d;
                found = m;
            }
        }

        if (found >= 0 && best <= maxMove) {

            used.add(found);

            const q = b[found];

            out.push({
                ...p,
                x: lerp(ax, (Number(q.x) || 0) + offB.x, t),
                y: lerp(ay, (Number(q.y) || 0) + offB.y, t),
                rotate: lerpAngle(Number(p.rotate) || 0, Number(q.rotate) || 0, t),
                opacity: lerp(opacityOf(p), opacityOf(q), t),
                _order: i
            });

            return;
        }

        out.push({
            ...p,
            x: ax,
            y: ay,
            opacity: i === 0
                ? (t < 0.5 ? opacityOf(p) : 0)
                : opacityOf(p) * (1 - t),
            _order: i
        });
    });

    b.forEach((q, j) => {

        if (used.has(j) || !q || !(q.w > 0) || !(q.h > 0)) return;

        out.push({
            ...q,
            x: (Number(q.x) || 0) + offB.x,
            y: (Number(q.y) || 0) + offB.y,
            opacity: j === 0
                ? (t >= 0.5 ? opacityOf(q) : 0)
                : opacityOf(q) * t,
            _order: j
        });
    });

    // l'indice piu' alto sta in fondo: il renderer disegna dall'ultimo al primo
    out.sort((m, n) => m._order - n._order);

    return out.filter(p => p.opacity > 0.4);
}

/*
    Pezzi da disegnare per il frame "index" della sequenza, a
    t (0..1) del suo tempo. Con smooth = false (o t = 0) e' il
    frame esatto del file.
*/

export function composeFrame({ sequence, framesDB, shifts, index, t = 0, smooth = false }) {

    const f = sequence[index];

    if (!f) return null;

    const cur = framesDB[f.id];

    if (!cur) return null;

    const offA = offsetFor(f, shifts);

    if (!smooth || t <= 0 || sequence.length < 2) return placed(cur, offA);

    const g = sequence[(index + 1) % sequence.length];
    const nxt = framesDB[g.id];

    if (!nxt) return placed(cur, offA);

    return blendPieces(cur, nxt, t, offA, offsetFor(g, shifts));
}


// ------------------------------------------------------------
// AREA CHE CONTIENE TUTTI I FRAME (per GIF e PNG)
// ------------------------------------------------------------

export function sequenceBounds(sequence, framesDB, shifts) {

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

    for (const f of sequence) {

        const pieces = framesDB[f.id];

        if (!pieces) continue;

        for (const p of placed(pieces, offsetFor(f, shifts))) {

            const cx = p.x + p.w / 2;
            const cy = p.y + p.h / 2;

            const r = (Number(p.rotate) || 0) * Math.PI / 180;
            const c = Math.cos(r), s = Math.sin(r);

            for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {

                const ux = dx * p.w / 2;
                const uy = dy * p.h / 2;

                const X = cx + ux * c - uy * s;
                const Y = cy + ux * s + uy * c;

                x0 = Math.min(x0, X); x1 = Math.max(x1, X);
                y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
            }
        }
    }

    if (!(x0 <= x1)) return { x: 0, y: 0, w: 1, h: 1 };

    return {
        x: Math.floor(x0) - 2,
        y: Math.floor(y0) - 2,
        w: Math.ceil(x1) - Math.floor(x0) + 4,
        h: Math.ceil(y1) - Math.floor(y0) + 4
    };
}
