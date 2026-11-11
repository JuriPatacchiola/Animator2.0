// ============================================================
// GOMMA: cancella i pixel che scegli tu
//
// Niente viene modificato nei file originali (PNG, CGG, CGS, .sam):
// la gomma tiene delle MASCHERE (un pixel acceso = pixel nascosto) e il
// disegno dei pezzi le applica ogni volta. Per questo la cancellazione
// vale ovunque: anteprima, GIF, APNG, WebP, video, PNG e "Esporta per il
// sito" (e si puo' sempre annullare).
//
// Due ambiti:
//   - "frame": la maschera appartiene a UN pezzo di UN fotogramma del CGG
//     (riga + numero del pezzo). Gli altri fotogrammi non cambiano.
//   - "sheet": la maschera appartiene al foglio (PNG / atlante): il pixel
//     sparisce da tutti i fotogrammi che lo usano.
//
// Le cancellazioni si ricordano nel browser (per ogni unita').
// ============================================================

// chiave del pezzo dentro un fotogramma ("riga:numero"): e' un Symbol, cosi' si copia
// con {...pezzo} ma non entra in JSON.stringify (le firme dei fotogrammi non cambiano)
export const EK = Symbol('erase-key');

const STORE = 'animator.erase.';

const rle = (bits) => {

    const out = [];

    for (let i = 0, n = bits.length; i < n;) {

        if (!bits[i]) { i++; continue; }

        let j = i;

        while (j < n && bits[j]) j++;

        out.push(i, j - i);

        i = j;
    }

    return out;
};

// rimette in una maschera le sequenze (inizio, lunghezza); ritorna quanti pixel
const unrle = (runs, mask) => {

    let n = 0;

    if (!Array.isArray(runs)) return 0;

    for (let k = 0; k + 1 < runs.length; k += 2) {

        const s = runs[k] | 0;
        const l = runs[k + 1] | 0;

        if (s < 0 || l < 1 || s + l > mask.bits.length) continue;

        for (let i = s; i < s + l; i++) {

            if (!mask.bits[i]) { mask.bits[i] = 1; n++; }
        }
    }

    mask.count += n;

    return n;
};

const mix = (h, v) => Math.imul((h ^ (v & 0xffffffff)) >>> 0, 16777619) >>> 0;

/*
    Dove va a finire un pixel del pezzo (coordinate del pezzo: u, v = colonna e riga di pixel,
    0..w / 0..h) nelle coordinate dell'animatore. E' la stessa matematica di Renderer.drawPieces.
    world.x = a*u + c*v + e ; world.y = b*u + d*v + f
*/
export function pieceMatrix(p) {

    // pezzo del formato .sam
    if (p.sam) {

        const m = p.mat || [1, 0, 0, 1];
        const r = Number(p.rad) || 0;
        const cs = Math.cos(r), sn = Math.sin(r);

        const a = cs * m[0] - sn * m[1];
        const b = sn * m[0] + cs * m[1];
        const c = cs * m[2] - sn * m[3];
        const d = sn * m[2] + cs * m[3];

        const ox = Number(p.ox) || 0;
        const oy = Number(p.oy) || 0;

        return [a, b, c, d, (Number(p.x) || 0) + a * ox + c * oy, (Number(p.y) || 0) + b * ox + d * oy];
    }

    // pezzo del formato CGG: perno al centro, poi specchio, poi rotazione (segno negativo)
    const w = p.w, h = p.h;

    const fl = Number(p.flipType) || 0;
    const sx = (fl === 1 || fl === 3) ? -1 : 1;
    const sy = (fl === 2 || fl === 3) ? -1 : 1;

    const rot = -(Number(p.rotate) || 0) * Math.PI / 180;
    const cs = Math.cos(rot), sn = Math.sin(rot);

    const a = sx * cs;
    const b = sy * sn;
    const c = -sx * sn;
    const d = sy * cs;

    const cx = (Number(p.x) || 0) + w / 2;
    const cy = (Number(p.y) || 0) + h / 2;

    return [a, b, c, d, cx - a * w / 2 - c * h / 2, cy - b * w / 2 - d * h / 2];
}

export const Eraser = {

    // ---- impostazioni (le cambia l'interfaccia)
    on: false,
    size: 6,                // diametro del pennello, in pixel dello sprite
    scope: 'frame',         // 'frame' | 'sheet'
    topOnly: false,         // true: cancella solo il pezzo che si vede in cima

    // ---- dati dell'unita' caricata
    image: null,
    W: 0,
    H: 0,
    alpha: null,            // alfa di ogni pixel del foglio (serve a sapere cosa si vede)
    sheetMask: { bits: new Uint8Array(0), count: 0, ver: 0 },
    inst: new Map(),        // "riga:pezzo" -> { w, h, bits, count, ver }
    rowsSig: 0,
    key: '',

    // ---- stato
    version: 0,
    any: false,
    cache: new Map(),
    ops: null,
    undoStack: [],
    redoStack: [],
    saveTimer: 0,
    onChange: null,         // chiamata dopo ogni modifica (interfaccia)


    // =========================================================
    // COLLEGAMENTO CON L'UNITA'
    // =========================================================

    // dà a ogni pezzo la sua chiave "riga:numero"
    tag(framesDB) {

        for (let i = 0; i < framesDB.length; i++) {

            const row = framesDB[i];

            if (!row) continue;

            for (let j = 0; j < row.length; j++) {

                if (row[j]) row[j][EK] = i + ':' + j;
            }
        }
    },

    /*
        Da chiamare quando si carica un'unita' (o si cambia foglio).
        rowsOriginal = i fotogrammi cosi' come sono nel file (senza l'ombra aggiunta),
        rowsInUse = quelli in uso (servono per dare la chiave ai pezzi).
    */
    attach(image, rowsOriginal, rowsInUse) {

        this.image = image || null;
        this.W = image ? (image.naturalWidth || image.width || 0) : 0;
        this.H = image ? (image.naturalHeight || image.height || 0) : 0;

        this.alpha = null;

        // alfa di ogni pixel del foglio
        if (this.W && this.H) {

            try {

                const cv = document.createElement('canvas');

                cv.width = this.W;
                cv.height = this.H;

                const ctx = cv.getContext('2d', { willReadFrequently: true });

                ctx.drawImage(image, 0, 0);

                const px = ctx.getImageData(0, 0, this.W, this.H).data;

                this.alpha = new Uint8Array(this.W * this.H);

                for (let i = 0; i < this.alpha.length; i++) this.alpha[i] = px[i * 4 + 3];

            } catch (e) { this.alpha = null; }
        }

        // chi e' questa unita': misure e forma del foglio + elenco dei ritagli
        let hs = mix(mix(2166136261, this.W), this.H);

        if (this.alpha) {

            const stride = Math.max(1, Math.floor(this.alpha.length / 262144));

            for (let i = 0; i < this.alpha.length; i += stride) hs = mix(hs, this.alpha[i]);
        }

        this.key = STORE + hs.toString(36);

        let rs = 2166136261;

        const rows = rowsOriginal || [];

        rs = mix(rs, rows.length);

        for (const row of rows) {

            rs = mix(rs, row ? row.length : 0);

            for (const p of row || []) rs = mix(mix(mix(mix(rs, p.sx), p.sy), p.w), p.h);
        }

        this.rowsSig = rs;

        this.sheetMask = { bits: new Uint8Array(this.W * this.H), count: 0, ver: 0 };
        this.inst = new Map();
        this.undoStack = [];
        this.redoStack = [];
        this.ops = null;

        if (rowsInUse) this.tag(rowsInUse);

        this._load();

        this._touch();
    },


    // =========================================================
    // PENNELLO
    // =========================================================

    // centro del pennello agganciato alla griglia dei pixel: misure dispari = centro del pixel,
    // pari = incrocio tra quattro pixel
    snap(x, y) {

        const n = Math.max(1, Math.round(this.size));

        return n % 2
            ? [Math.floor(x) + 0.5, Math.floor(y) + 0.5]
            : [Math.round(x), Math.round(y)];
    },

    beginStroke() {

        this.ops = new Map();
    },

    endStroke() {

        const ops = this.ops;

        this.ops = null;

        if (!ops || !ops.size) return;

        this.undoStack.push(ops);

        if (this.undoStack.length > 300) this.undoStack.shift();

        this.redoStack = [];

        this._changed();
    },

    /*
        Cancella (o con restore = true RIPRISTINA) i pixel sotto il pennello.
        pieces = i pezzi del fotogramma mostrato (il primo e' quello in primo piano).
        (x, y) = punto nelle coordinate dell'animatore. Ritorna quanti pixel sono cambiati.
    */
    paint(pieces, x, y, restore = false) {

        const [cx, cy] = this.snap(x, y);

        const r = Math.max(1, Math.round(this.size)) / 2;
        const r2 = r * r + 1e-6;

        const W = this.W, H = this.H;

        if (!W || !H) return 0;

        const claimed = (!restore && this.topOnly) ? new Set() : null;

        let changed = 0;

        for (const p of pieces) {

            if (!p || !(p.w > 0) || !(p.h > 0)) continue;

            const [a, b, c, d, e, f] = pieceMatrix(p);

            const det = a * d - b * c;

            if (Math.abs(det) < 1e-9) continue;

            const inv = (X, Y) => [(d * (X - e) - c * (Y - f)) / det, (a * (Y - f) - b * (X - e)) / det];

            // quali pixel del pezzo possono stare sotto il pennello
            const pad = r + 1.5;

            let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;

            for (const [X, Y] of [[cx - pad, cy - pad], [cx + pad, cy - pad], [cx - pad, cy + pad], [cx + pad, cy + pad]]) {

                const [u, v] = inv(X, Y);

                if (u < uMin) uMin = u;
                if (u > uMax) uMax = u;
                if (v < vMin) vMin = v;
                if (v > vMax) vMax = v;
            }

            const u0 = Math.max(0, Math.floor(uMin) - 1);
            const u1 = Math.min(p.w - 1, Math.ceil(uMax) + 1);
            const v0 = Math.max(0, Math.floor(vMin) - 1);
            const v1 = Math.min(p.h - 1, Math.ceil(vMax) + 1);

            if (u0 > u1 || v0 > v1) continue;

            // il pixel che sta proprio sotto il cursore si prende sempre (anche nei pezzi ingranditi)
            const [cu, cv] = inv(x, y);
            const hu = Math.floor(cu), hv = Math.floor(cv);

            const ek = p[EK];

            for (let v = v0; v <= v1; v++) {

                for (let u = u0; u <= u1; u++) {

                    const wx = a * (u + 0.5) + c * (v + 0.5) + e;
                    const wy = b * (u + 0.5) + d * (v + 0.5) + f;

                    const dx = wx - cx, dy = wy - cy;

                    if (dx * dx + dy * dy > r2 && !(u === hu && v === hv)) continue;

                    const X = p.sx + u, Y = p.sy + v;

                    if (X < 0 || Y < 0 || X >= W || Y >= H) continue;

                    const si = Y * W + X;

                    const im = ek ? this.inst.get(ek) : null;
                    const ii = v * p.w + u;

                    const hiddenSheet = this.sheetMask.bits[si] === 1;
                    const hiddenInst = !!(im && im.w === p.w && im.h === p.h && im.bits[ii] === 1);

                    if (restore) {

                        if (hiddenSheet) { this._set('S', this.sheetMask, si, false); changed++; }

                        if (hiddenInst) { this._set(ek, im, ii, false); changed++; }

                        continue;
                    }

                    // gia' nascosto, o trasparente: niente da fare
                    if (hiddenSheet || hiddenInst) continue;

                    if (this.alpha && this.alpha[si] === 0) continue;

                    // "solo in cima": il primo pezzo che si vede in quel punto prende il pixel, quelli sotto restano
                    if (claimed) {

                        const cell = Math.floor(wx) + ',' + Math.floor(wy);

                        if (claimed.has(cell)) continue;

                        claimed.add(cell);
                    }

                    if (this.scope === 'sheet') {

                        this._set('S', this.sheetMask, si, true);

                    } else {

                        if (!ek) continue;

                        this._set(ek, this._inst(ek, p.w, p.h), ii, true);
                    }

                    changed++;
                }
            }
        }

        if (changed) this._touch();

        return changed;
    },

    // pennello lungo un tratto (il mouse salta: si riempie il vuoto)
    stroke(pieces, x0, y0, x1, y1, restore = false) {

        const dist = Math.hypot(x1 - x0, y1 - y0);

        const steps = Math.max(1, Math.ceil(dist / 0.5));

        let changed = 0;

        for (let i = 0; i <= steps; i++) {

            const t = i / steps;

            changed += this.paint(pieces, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, restore);
        }

        return changed;
    },


    // =========================================================
    // MASCHERE
    // =========================================================

    _inst(ek, w, h) {

        let m = this.inst.get(ek);

        if (!m || m.w !== w || m.h !== h) {

            m = { w, h, bits: new Uint8Array(w * h), count: 0, ver: 0 };

            this.inst.set(ek, m);
        }

        return m;
    },

    _set(target, mask, idx, on) {

        const v = on ? 1 : 0;

        if (mask.bits[idx] === v) return;

        mask.bits[idx] = v;
        mask.count += on ? 1 : -1;
        mask.ver++;

        if (!this.ops) this.ops = new Map();

        let o = this.ops.get(target);

        if (!o) this.ops.set(target, o = { mask, on: [], off: [] });

        (on ? o.on : o.off).push(idx);
    },

    // qualcosa e' cambiato: il disegno dei pezzi deve ricalcolare i ritagli
    _touch() {

        this.version++;

        this.cache.clear();

        this.any = this.sheetMask.count > 0;

        if (!this.any) for (const m of this.inst.values()) if (m.count) { this.any = true; break; }
    },

    _changed() {

        this._touch();

        this._saveSoon();

        if (this.onChange) this.onChange();
    },


    // =========================================================
    // ANNULLA / RIPETI / RIPRISTINA
    // =========================================================

    undo() {

        const ops = this.undoStack.pop();

        if (!ops) return false;

        for (const o of ops.values()) {

            for (const i of o.on) { if (o.mask.bits[i]) { o.mask.bits[i] = 0; o.mask.count--; } }
            for (const i of o.off) { if (!o.mask.bits[i]) { o.mask.bits[i] = 1; o.mask.count++; } }

            o.mask.ver++;
        }

        this.redoStack.push(ops);

        this._changed();

        return true;
    },

    redo() {

        const ops = this.redoStack.pop();

        if (!ops) return false;

        for (const o of ops.values()) {

            for (const i of o.on) { if (!o.mask.bits[i]) { o.mask.bits[i] = 1; o.mask.count++; } }
            for (const i of o.off) { if (o.mask.bits[i]) { o.mask.bits[i] = 0; o.mask.count--; } }

            o.mask.ver++;
        }

        this.undoStack.push(ops);

        this._changed();

        return true;
    },

    get canUndo() { return this.undoStack.length > 0; },
    get canRedo() { return this.redoStack.length > 0; },

    // toglie tutte le cancellazioni dei pezzi di un fotogramma (si puo' annullare)
    clearFrame(rowId) {

        this.beginStroke();

        for (const [k, m] of this.inst) {

            if (!k.startsWith(rowId + ':') || !m.count) continue;

            for (let i = 0; i < m.bits.length; i++) if (m.bits[i]) this._set(k, m, i, false);
        }

        const n = this.ops.size;

        this.endStroke();

        return n > 0;
    },

    // toglie tutto (si puo' annullare)
    clearAll() {

        this.beginStroke();

        const sm = this.sheetMask;

        for (let i = 0; i < sm.bits.length; i++) if (sm.bits[i]) this._set('S', sm, i, false);

        for (const [k, m] of this.inst) {

            for (let i = 0; i < m.bits.length; i++) if (m.bits[i]) this._set(k, m, i, false);
        }

        const n = this.ops.size;

        this.endStroke();

        return n > 0;
    },

    stats() {

        let inst = 0;

        const rows = new Set();

        for (const [k, m] of this.inst) {

            if (!m.count) continue;

            inst += m.count;

            rows.add(k.slice(0, k.indexOf(':')));
        }

        return { sheet: this.sheetMask.count, inst, frames: rows.size };
    },

    // quanti pixel sono cancellati in un fotogramma (per mostrarlo nell'interfaccia)
    countInRow(rowId) {

        let n = 0;

        for (const [k, m] of this.inst) if (m.count && k.startsWith(rowId + ':')) n += m.count;

        return n;
    },


    // =========================================================
    // DISEGNO: ritaglio del pezzo senza i pixel cancellati
    //
    // Ritorna un canvas w x h (da disegnare da 0,0) oppure null se il pezzo
    // non ha pixel cancellati (si disegna come sempre dal foglio).
    // =========================================================

    cropFor(image, p) {

        if (!this.any || image !== this.image) return null;

        const ek = p[EK];

        const key = (ek || '') + '|' + p.sx + ',' + p.sy + ',' + p.w + ',' + p.h;

        const hit = this.cache.get(key);

        if (hit !== undefined) return hit;

        const w = p.w | 0, h = p.h | 0;

        const im = ek ? this.inst.get(ek) : null;

        const useInst = !!(im && im.count && im.w === w && im.h === h);

        const W = this.W, H = this.H;

        const erased = new Uint8Array(w * h);

        let any = false;

        for (let v = 0; v < h; v++) {

            const Y = p.sy + v;

            if (Y < 0 || Y >= H) continue;

            for (let u = 0; u < w; u++) {

                const X = p.sx + u;

                if (X < 0 || X >= W) continue;

                if ((this.sheetMask.count && this.sheetMask.bits[Y * W + X]) || (useInst && im.bits[v * w + u])) {

                    erased[v * w + u] = 1;
                    any = true;
                }
            }
        }

        if (!any) {

            this.cache.set(key, null);

            return null;
        }

        const cv = document.createElement('canvas');

        cv.width = w;
        cv.height = h;

        const ctx = cv.getContext('2d');

        ctx.drawImage(image, p.sx, p.sy, w, h, 0, 0, w, h);

        // clearRect lascia intatti tutti gli altri pixel (nessuna conversione dei colori)
        for (let v = 0; v < h; v++) {

            for (let u = 0; u < w;) {

                if (!erased[v * w + u]) { u++; continue; }

                let e = u;

                while (e < w && erased[v * w + e]) e++;

                ctx.clearRect(u, v, e - u, 1);

                u = e;
            }
        }

        this.cache.set(key, cv);

        return cv;
    },

    // firma di un fotogramma: JSON dei pezzi + (se ci sono cancellazioni) quali pezzi hanno una maschera.
    // Senza cancellazioni e' identica a JSON.stringify(pieces), come prima.
    sig(pieces) {

        const s = JSON.stringify(pieces);

        if (!this.inst.size) return s;

        let t = '';

        for (const p of pieces) {

            const k = p && p[EK];

            if (!k) continue;

            const m = this.inst.get(k);

            if (m && m.count) t += '|' + k + '@' + m.ver;
        }

        return t ? s + t : s;
    },


    // =========================================================
    // SALVATAGGIO NEL BROWSER
    // =========================================================

    _saveSoon() {

        clearTimeout(this.saveTimer);

        this.saveTimer = setTimeout(() => this._save(), 300);
    },

    _save() {

        if (!this.key) return;

        try {

            const st = this.stats();

            if (!st.sheet && !st.inst) {

                localStorage.removeItem(this.key);

                return;
            }

            const inst = {};

            for (const [k, m] of this.inst) if (m.count) inst[k] = { w: m.w, h: m.h, r: rle(m.bits) };

            localStorage.setItem(this.key, JSON.stringify({
                v: 1,
                rows: this.rowsSig,
                sheet: rle(this.sheetMask.bits),
                inst
            }));

            this.saveError = false;

        } catch (e) {

            this.saveError = true;
        }
    },

    _load() {

        try {

            const t = localStorage.getItem(this.key);

            if (!t) return;

            const d = JSON.parse(t);

            if (!d || d.v !== 1) return;

            unrle(d.sheet, this.sheetMask);

            // le cancellazioni per fotogramma valgono solo se l'elenco dei ritagli e' lo stesso
            if (d.rows === this.rowsSig && d.inst) {

                for (const k of Object.keys(d.inst)) {

                    const e = d.inst[k];

                    if (!e || !(e.w > 0) || !(e.h > 0) || e.w * e.h > 4e6) continue;

                    const m = this._inst(k, e.w | 0, e.h | 0);

                    unrle(e.r, m);
                }
            }

        } catch (e) { /* dati rovinati: si riparte da zero */ }
    }
};
