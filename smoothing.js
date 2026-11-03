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


/*
    Riconosce il pezzo "ombra": l'ultimo pezzo di quasi tutte le righe del
    CGG e' sempre lo stesso ritaglio (o al massimo due). Restituisce l'insieme
    delle chiavi (pieceKey) di quei ritagli, oppure null se non c'e' un'ombra
    riconoscibile.
*/

export function findShadowKeys(framesDB) {

    // le righe vuote (posti non usati del CGG) non contano
    const used = framesDB.filter(pieces => pieces && pieces.length).length;

    if (used < 2) return null;

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

    // se non c'e' un'ombra riconoscibile non si tocca niente
    if (covered / used < 0.7 || top.some(e => e[1] < 2)) return null;

    return new Set(top.map(e => e[0]));
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

    const shadowKeys = findShadowKeys(framesDB);

    if (!shadowKeys) return none;

    const anchors = framesDB.map(pieces => {

        const p = pieces[pieces.length - 1];

        if (!p || !shadowKeys.has(pieceKey(p)) || !(p.w > p.h)) return null;

        // .sam: x,y e' il punto d'aggancio del frammento, l'angolo in alto a sinistra e' x+ox, y+oy
        const ox = p.sam ? Number(p.ox) || 0 : 0;
        const oy = p.sam ? Number(p.oy) || 0 : 0;

        return { x: p.x + ox + p.w / 2, y: p.y + oy + p.h / 2 };
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

// segno del determinante della matrice di un pezzo .sam (specchiato = -1)
function handed(p) {

    const m = p.mat;

    if (!m) return 1;

    return m[0] * m[3] - m[1] * m[2] < 0 ? -1 : 1;
}

/*
    Formato .sam: ogni posa e' fatta di frammenti propri (a ogni posa cambiano quasi
    tutti i disegni), quindi tra due pose non c'e' niente da muovere: i pezzi diversi
    si possono solo tenere fermi o dissolvere. "samSoft" e' la parte finale del frame
    in cui avviene la dissolvenza (0 = taglio netto, come nel file; 1 = per tutto il
    frame). I pezzi che sono lo stesso disegno in entrambe le pose si muovono sempre
    in modo continuo.
*/

let samSoft = 0;

export function setSamSoft(v) {

    const n = Number(v);

    samSoft = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function samFade(t) {

    if (samSoft <= 0) return t >= 1 ? 1 : 0;

    if (samSoft >= 1) return t;

    return Math.min(1, Math.max(0, (t - (1 - samSoft)) / samSoft));
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

            // formato .sam: un pezzo specchiato non diventa quello non specchiato a meta' strada
            if (p.sam && handed(p) !== handed(b[m])) continue;

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

            const moved = {
                ...p,
                x: lerp(ax, (Number(q.x) || 0) + offB.x, t),
                y: lerp(ay, (Number(q.y) || 0) + offB.y, t),
                rotate: lerpAngle(Number(p.rotate) || 0, Number(q.rotate) || 0, t),
                opacity: lerp(opacityOf(p), opacityOf(q), t),
                _order: i
            };

            // formato .sam: anche rotazione (radianti, per la via piu' corta) e matrice
            if (p.sam && q.sam) {

                moved.rad = lerpAngle((Number(p.rad) || 0) * 180 / Math.PI, (Number(q.rad) || 0) * 180 / Math.PI, t) * Math.PI / 180;

                if (p.mat || q.mat) {

                    const ma = p.mat || [1, 0, 0, 1];
                    const mb = q.mat || [1, 0, 0, 1];

                    moved.mat = ma.map((v, k) => lerp(v, mb[k], t));
                }
            }

            out.push(moved);

            return;
        }

        // formato .sam: la dissolvenza avviene solo alla fine del frame (vedi samSoft)
        const ta = p.sam ? samFade(t) : t;

        out.push({
            ...p,
            x: ax,
            y: ay,
            opacity: i === 0
                ? (ta < 0.5 ? opacityOf(p) : 0)
                : opacityOf(p) * (1 - ta),
            _order: i
        });
    });

    b.forEach((q, j) => {

        if (used.has(j) || !q || !(q.w > 0) || !(q.h > 0)) return;

        const tb = q.sam ? samFade(t) : t;

        out.push({
            ...q,
            x: (Number(q.x) || 0) + offB.x,
            y: (Number(q.y) || 0) + offB.y,
            opacity: j === 0
                ? (tb >= 0.5 ? opacityOf(q) : 0)
                : opacityOf(q) * tb,
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

            // pezzo del formato .sam: gli angoli del PNG, ruotati e deformati attorno all'origine
            if (p.sam) {

                const m = p.mat || [1, 0, 0, 1];
                const r = Number(p.rad) || 0;
                const c = Math.cos(r), s = Math.sin(r);

                for (const [px, py] of [
                    [p.ox, p.oy], [p.ox + p.w, p.oy], [p.ox, p.oy + p.h], [p.ox + p.w, p.oy + p.h]
                ]) {

                    const ax = m[0] * px + m[2] * py;
                    const ay = m[1] * px + m[3] * py;

                    const X = p.x + ax * c - ay * s;
                    const Y = p.y + ax * s + ay * c;

                    x0 = Math.min(x0, X); x1 = Math.max(x1, X);
                    y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
                }

                continue;
            }

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