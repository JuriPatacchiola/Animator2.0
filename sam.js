// ============================================================
// FORMATO .SAM  (file di animazione + frammenti PNG)
//
// Un'unita' in questo formato e' un file .sam (le animazioni: Idle, Move,
// Attack, Dead...) piu' tanti PNG piccoli, uno per ogni frammento. Non ha
// ne' lo sheet ne' il CGG: qui i frammenti vengono impacchettati in un
// atlante e ogni frame del .sam diventa una "riga" di pezzi, cosi' tutto
// il resto dell'app (zoom, area, morbido, GIF, APNG, video, PNG...)
// funziona uguale che con i file CGG / CGS.
// ============================================================

// Lettore del formato .sam (magic "MAS"). Unità: x,y in 1/20 di pixel, rot in millesimi di radiante.
// blk (se presente) = matrice 2x2 in virgola fissa 16.16 (a,b,c,d): specchiature e scale dei pezzi.
class Rd {
  constructor(b, p = 0) { this.b = b; this.p = p; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u8() { if (this.p < 0 || this.p >= this.b.length) throw new RangeError('fine dati'); return this.b[this.p++]; }
  u16() { const v = this.v.getUint16(this.p, true); this.p += 2; return v; }
  i16() { const v = this.v.getInt16(this.p, true); this.p += 2; return v; }
  i32() { const v = this.v.getInt32(this.p, true); this.p += 4; return v; }
  u32() { const v = this.v.getUint32(this.p, true); this.p += 4; return v; }
  str() { const n = this.u16(); const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
}
function readItem(r) {
  const it = { slot: r.u8() };
  const fl = r.u8(); it.flags = fl;
  if (fl & 0x40) it.rot = r.i16();
  if (fl & 0x10) { const blk = []; for (let k = 0; k < 8; k++) blk.push(r.u16()); it.blk = blk; }
  if (fl & 0x08) { it.x = r.i32(); it.y = r.i32(); }
  if (fl & 0x20) it.color = r.u32();
  if (fl & ~0x78) throw new Error('flag ignoto ' + fl.toString(16));
  return it;
}
// elenco di elementi: [n][slot,flags,...]*n  -> [items, posizione finale] oppure null
function tryItems(b, p) {
  try {
    const r = new Rd(b, p), n = r.u8();
    if (n < 1) return null;
    const its = []; for (let k = 0; k < n; k++) its.push(readItem(r));
    if (its.some(i => i.slot < 1)) return null;
    return [its, r.p];
  } catch (e) { return null; }
}
export function parseSam(buf) {
  const d = new Uint8Array(buf), dv = new DataView(buf);
  if (d.length < 40 || d[0] !== 0x4d || d[1] !== 0x41 || d[2] !== 0x53) throw new Error('non è un file .sam (manca la firma MAS)');
  const version = dv.getUint32(4, true), count = dv.getUint32(8, true);
  // --- tabella dei frammenti PNG: nome (u16 + testo) + 12 valori int16
  const dec = new TextDecoder();
  const nameAt = p => {
    if (p < 0 || p + 2 > d.length) return null;
    const n = dv.getUint16(p, true);
    if (n < 5 || n > 200 || p + 2 + n + 24 > d.length) return null;
    const s = dec.decode(d.subarray(p + 2, p + 2 + n));
    return /^[\x20-\x7e]+\.png$/i.test(s) ? s : null;
  };
  let p = 27;
  if (nameAt(p) === null) {
    p = -1;
    for (let q = 12; q < Math.min(d.length - 30, 400); q++) if (nameAt(q) !== null) { p = q; break; }
    if (p < 0) throw new Error('tabella dei frammenti non trovata');
  }
  const sprites = []; let nm0;
  while ((nm0 = nameAt(p)) !== null) {
    const n = dv.getUint16(p, true), o = p + 2 + n, f = [];
    for (let k = 0; k < 12; k++) f.push(dv.getInt16(o + 2 * k, true));
    sprites.push({ i: sprites.length, file: nm0, w: f[0], h: f[1], matrix: [f[3], f[4], f[5], f[6], f[7], f[9]], ox: f[10] / 20, oy: f[11] / 20 });
    p = o + 24;
  }
  if (!sprites.length) throw new Error('nessun frammento nella tabella');
  const nSp = sprites.length;
  // --- sezione animazioni
  const t = d.subarray(p), r = new Rd(t), tdv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const header = [r.u16(), r.u8()];
  const nsl = r.u8(), slots = [];
  for (let k = 0; k < nsl; k++) slots.push([r.u8(), r.u8(), r.u8()]);
  // posizioni (u16 della lunghezza) dove c'e' un possibile nome di animazione: "Idle", "Attack", ...
  const isNameCh = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  const cand = new Set();
  for (let m = r.p + 2; m < t.length - 3; m++) {
    const c = t[m]; if (c < 65 || c > 90) continue;
    const L = t[m - 2] | (t[m - 1] << 8);
    if (L < 3 || L > 24 || m + L > t.length) continue;
    let ok = true; for (let k = 1; k < L; k++) if (!isNameCh(t[m + k])) { ok = false; break; }
    if (ok) cand.add(m - 2);
  }
  // ogni animazione = [posa][nome][frame...]; la posa della successiva finisce esattamente sul suo nome
  const boundary = pp => { const q = tryItems(t, pp); return q && cand.has(q[1]) ? q[1] : -1; };
  const triples = (pp, n) => {
    if (n === undefined) return null;
    const out = [];
    for (let j = 0; j < n; j++) {
      const sl = t[pp + 3 * j], z = t[pp + 3 * j + 1], ix = t[pp + 3 * j + 2];
      if (!(sl >= 1 && z === 0 && ix < nSp)) return null;
      out.push({ slot: sl, sprite: ix });
    }
    return [out, pp + 3 * n];
  };
  const okItems = pp => { const q2 = tryItems(t, pp); return q2 && q2[0].every(i => i.flags & 0x08) ? q2 : null; };
  const atEnd = pp => pp >= t.length || boundary(pp) >= 0 || cand.has(pp);
  const anims = {}, warnings = [];
  let pos = r.p;
  while (pos < t.length && Object.keys(anims).length < 64) {
    let pq = tryItems(t, pos);
    if (pq && cand.has(pq[1])) r.p = pq[1];                 // [posa][nome]
    else if (cand.has(pos)) { pq = [[], pos]; r.p = pos; }    // [nome] senza posa davanti
    else throw new Error('posa iniziale non leggibile (animazione ' + (Object.keys(anims).length + 1) + ')');
    let nm = r.str();
    if (!/^[A-Za-z][A-Za-z0-9_]{1,31}$/.test(nm)) throw new Error('nome animazione non valido');
    while (anims[nm]) nm += '_2';
    const frames = []; let next = -1;
    while (r.p < t.length) {
      if (boundary(r.p) >= 0 || cand.has(r.p)) { next = r.p; break; }
      const start = r.p, dur = r.u8();
      const q = okItems(r.p);
      if (q) { frames.push({ dur, items: q[0] }); r.p = q[1]; continue; }
      // frame con cambio di sprite: [dur][n][(slot,0,sprite)*n][items]
      const n = t[start + 1];
      let tr = triples(start + 2, n);
      if (tr) {
        if (atEnd(tr[1])) { frames.push({ dur, swap: tr[0], items: [] }); r.p = tr[1]; continue; }   // record di chiusura
        const q2 = okItems(tr[1]);
        if (q2) { frames.push({ dur, swap: tr[0], items: q2[0] }); r.p = q2[1]; continue; }
      }
      // variante con elenco "hide": [dur][n][u16*n][m][(slot,0,sprite)*m][items]
      let hid = null;
      try { hid = []; for (let j = 0; j < n; j++) hid.push(tdv.getUint16(start + 2 + 2 * j, true)); } catch (e) { hid = null; }
      if (hid) {
        const p2 = start + 2 + 2 * n;
        tr = triples(p2 + 1, t[p2]);
        if (tr) {
          if (atEnd(tr[1])) { frames.push({ dur, hide: hid, swap: tr[0], items: [] }); r.p = tr[1]; continue; }
          const q2 = okItems(tr[1]);
          if (q2) { frames.push({ dur, hide: hid, swap: tr[0], items: q2[0] }); r.p = q2[1]; continue; }
        }
        // solo "hide", senza cambi di sprite: [dur][n][u16*n][items]
        if (atEnd(p2)) { frames.push({ dur, hide: hid, items: [] }); r.p = p2; continue; }
        const q3 = okItems(p2);
        if (q3) { frames.push({ dur, hide: hid, items: q3[0] }); r.p = q3[1]; continue; }
      }
      // frame non riconosciuto: salto alla prossima animazione (se c'e') e lo segnalo
      let s = start + 1; while (s < t.length && boundary(s) < 0 && !cand.has(s)) s++;
      const raw = Array.from(t.subarray(start, Math.min(s, start + 40))).map(x => x.toString(16).padStart(2, '0')).join(' ');
      warnings.push(nm + ': frame ' + frames.length + ' non decodificato (byte ' + start + ': ' + raw + ')');
      frames.push({ dur, swap_raw: raw, items: [] });
      r.p = s;
      if (s >= t.length) break;
    }
    anims[nm] = { pose: pq[0], frames, end: r.p, stop: next >= 0 ? next : t.length };
    if (next < 0) break;
    pos = next;
  }
  if (!Object.keys(anims).length) throw new Error('nessuna animazione trovata');
  return { version, declared_count: count, header, slots, sprites, anims, warnings };
}


// ------------------------------------------------------------
// NOMI DELLE ANIMAZIONI
//
// Idle / Move / Attack hanno gli stessi nomi interni del modo CGG
// (idle, move, atk), cosi' valgono anche le ripetizioni della "Completa".
// Le altre (Dead, ...) restano con il loro nome in minuscolo.
// ------------------------------------------------------------

export function samAnimKey(name) {

    const n = String(name).toLowerCase();

    if (n === 'idle') return 'idle';
    if (n === 'move') return 'move';
    if (n === 'attack' || n === 'atk') return 'atk';

    return n;
}

const identity = (m) =>
    Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 &&
    Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6;

// matrice 2x2 in virgola fissa 16.16, in ordine canvas (a, b, c, d)
function blkMatrix(blk) {

    if (!blk) return null;

    const g = (lo, hi) => ((lo | (hi << 16)) | 0) / 65536;

    const m = [g(blk[0], blk[1]), g(blk[2], blk[3]), g(blk[4], blk[5]), g(blk[6], blk[7])];

    return identity(m) ? null : m;
}

// ------------------------------------------------------------
// COSTRUZIONE DELL'UNITA'
//
// entries = [{ file, path }]: il .sam e tutti i PNG (anche di altre
// cartelle: per ogni frammento si preferisce il PNG della stessa
// cartella del .sam).
//
// Restituisce:
//   atlas      canvas con tutti i frammenti (diventa l'immagine del Renderer)
//   framesDB   una riga di pezzi per ogni frame di ogni animazione
//   sequences  { idle: [{id, xOffset, yOffset, duration}], ... }
//   order      nomi interni nell'ordine del file
//   labels     nome originale -> mostrato nel menu
//   missing    nomi dei PNG che non sono stati trovati
//   warnings   avvisi del lettore
//
// Ogni pezzo ha: x, y = punto d'origine del frammento (pixel, anche con
// decimali), ox, oy = angolo alto-sinistro del PNG rispetto all'origine,
// rad = rotazione (radianti), mat = matrice 2x2 (specchi e scale) oppure
// null, opacity, e il ritaglio dell'atlante sx, sy, w, h.
// ------------------------------------------------------------

const ATLAS_WIDTH = 2048;
const PAD = 2;

const dirOf = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

export async function buildSamUnit(samBuffer, entries, samPath = '') {

    const data = parseSam(samBuffer);

    // ---- PNG disponibili, per nome (senza badare alle maiuscole)
    const byName = new Map();

    for (const e of entries) {

        if (!/\.png$/i.test(e.file.name)) continue;

        const k = e.file.name.toLowerCase();

        if (!byName.has(k)) byName.set(k, []);

        byName.get(k).push(e);
    }

    const samDir = dirOf(samPath);

    const find = (name) => {

        const list = byName.get(name.toLowerCase());

        if (!list) return null;

        return (list.find(e => dirOf(e.path) === samDir) || list[0]).file;
    };

    // ---- lettura dei frammenti
    const sprites = data.sprites.map(s => ({ ...s, bmp: null }));

    const missing = [];

    await Promise.all(sprites.map(async (s) => {

        const f = find(s.file);

        if (!f) { missing.push(s.file); return; }

        try {

            s.bmp = await createImageBitmap(f);

        } catch (e) {

            missing.push(s.file);
        }
    }));

    // ---- atlante (file a scaffali, dal piu' alto al piu' basso)
    const order = sprites
        .filter(s => s.bmp)
        .sort((a, b) => b.bmp.height - a.bmp.height);

    let x = 0, y = 0, rowH = 0, maxX = 0;

    for (const s of order) {

        const w = s.bmp.width, h = s.bmp.height;

        if (x + w + PAD > ATLAS_WIDTH && x > 0) { x = 0; y += rowH + PAD; rowH = 0; }

        s.sx = x; s.sy = y; s.aw = w; s.ah = h;

        x += w + PAD;
        maxX = Math.max(maxX, x);
        rowH = Math.max(rowH, h);
    }

    const atlas = document.createElement('canvas');

    atlas.width = Math.max(1, maxX);
    atlas.height = Math.max(1, y + rowH);

    const actx = atlas.getContext('2d');

    for (const s of order) {

        actx.drawImage(s.bmp, s.sx, s.sy);

        s.bmp.close && s.bmp.close();
        s.bmp = null;
    }

    // ---- da .sam a righe di pezzi + sequenze
    const initial = {};

    data.slots.forEach(([slot, , sp]) => { initial[slot] = sp; });

    const map = { ...initial };

    const framesDB = [];
    const sequences = {};
    const labels = {};
    const names = [];

    for (const animName of Object.keys(data.anims)) {

        const key = samAnimKey(animName);

        const cur = { ...map };

        const seq = [];

        for (const f of data.anims[animName].frames) {

            for (const s of (f.swap || [])) {

                cur[s.slot] = s.sprite;
                map[s.slot] = s.sprite;
            }

            const pieces = [];

            // nel .sam gli elementi sono dal fondo al davanti; nell'app il primo pezzo e' quello davanti
            for (let i = f.items.length - 1; i >= 0; i--) {

                const it = f.items[i];

                if (it.x === undefined) continue;

                const sp = sprites[cur[it.slot]];

                if (!sp || sp.sx === undefined) continue;

                const opacity = it.color !== undefined ? (it.color >>> 24) / 255 * 100 : 100;

                if (opacity < 0.5) continue;

                pieces.push({
                    sam: true,
                    x: it.x / 20,
                    y: it.y / 20,
                    ox: sp.ox,
                    oy: sp.oy,
                    rad: (it.rot || 0) / 1000,
                    mat: blkMatrix(it.blk),
                    opacity,
                    flipType: 0,
                    blendMode: 0,
                    rotate: 0,
                    sx: sp.sx,
                    sy: sp.sy,
                    w: sp.aw,
                    h: sp.ah,
                    pageId: 0
                });
            }

            framesDB.push(pieces);

            seq.push({ id: framesDB.length - 1, xOffset: 0, yOffset: 0, duration: f.dur });
        }

        let k = key;

        while (sequences[k]) k += '_2';

        sequences[k] = seq;
        labels[k] = animName;
        names.push(k);
    }

    return {
        atlas,
        framesDB,
        sequences,
        order: names,
        labels,
        missing,
        warnings: data.warnings || [],
        spriteCount: sprites.length
    };
}
