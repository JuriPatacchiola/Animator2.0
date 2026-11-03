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

// animazioni che non servono (morte)
const SKIP_ANIM = /^(dead|death|die|dying)/i;

// impronta di una riga di pezzi: due frame con la stessa impronta si vedono identici
const rowKey = (pieces) => pieces.map(p => [
  p.sk, p.sx, p.sy, p.w, p.h, p.x, p.y, p.rad, p.mat ? p.mat.join(' ') : '', p.opacity
].join(',')).join('|');

/*
    Pulizia dei frame di un'animazione:
    - i frame vuoti (i "record di chiusura" del file) non si vedono mai: quelli
      all'inizio e alla fine si tolgono, quelli in mezzo cedono il tempo al frame prima;
    - due frame uguali di fila diventano uno solo, con la somma dei tempi (anche
      l'ultimo uguale al primo, che nel giro si vedrebbe due volte).
*/

function cleanFrames(frames) {

  let a = 0, z = frames.length;

  while (z > a && !frames[z - 1].pieces.length) z--;
  while (a < z && !frames[a].pieces.length) a++;

  const out = [];

  for (let i = a; i < z; i++) {

    const f = frames[i];
    const prev = out[out.length - 1];

    if (!f.pieces.length) {

      if (prev) prev.dur += f.dur;

      continue;
    }

    if (prev && prev.key === f.key) {

      prev.dur += f.dur;

      continue;
    }

    out.push({ ...f });
  }

  if (out.length > 1 && out[0].key === out[out.length - 1].key) {

    out[0].dur += out.pop().dur;
  }

  return out;
}

// numero + posizione dello stesso numero nell'elenco: "13#0", "13#1"
function keyed(list) {

  const seen = {};

  return list.map(e => {

    seen[e.slot] = seen[e.slot] === undefined ? 0 : seen[e.slot] + 1;

    return { ...e, sk: e.slot + '#' + seen[e.slot] };
  });
}

/*
    Punto dei piedi: il centro dell'ombra (il pezzo piu' in fondo, largo e basso)
    nel primo frame. Restituisce null se non si trova.
*/

function footPoint(framesDB, seq) {

  if (!seq || !seq.length) return null;

  const row = framesDB[seq[0].id] || [];

  // il pezzo in fondo (l'ultimo della riga) e' l'ombra se e' largo e basso
  const shadow = row[row.length - 1];

  if (!shadow || !(shadow.w > shadow.h)) return null;

  return { x: shadow.x + shadow.ox + shadow.w / 2, y: shadow.y + shadow.oy + shadow.h / 2 };
}

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
  //
  // Uno slot e' identificato da numero + posizione (se lo stesso numero compare
  // due volte in un elenco, la prima e la seconda volta sono pezzi diversi).
  const initial = {};

  keyed(data.slots.map(([slot, , sprite]) => ({ slot, sprite }))).forEach(e => { initial[e.sk] = e.sprite; });

  const map = { ...initial };

  const framesDB = [];
  const sequences = {};
  const labels = {};
  const names = [];
  const skipped = [];

  // i frame del file sono (quasi tutti) in ordine di slot? Allora l'ordine di disegno e' quello degli slot
  let ordered = 0, total = 0;

  for (const a of Object.values(data.anims)) {

    for (const f of a.frames) {

      const sl = f.items.filter(it => it.x !== undefined).map(it => it.slot);

      if (sl.length < 2) continue;

      total++;

      if (sl.every((v, i) => i === 0 || sl[i - 1] <= v)) ordered++;
    }
  }

  const zBySlot = total === 0 || ordered >= total * 0.5;

  for (const animName of Object.keys(data.anims)) {

    const key = samAnimKey(animName);

    const cur = { ...map };

    // ---- 1. un record per frame, con i frammenti che valgono in quel momento
    const recs = data.anims[animName].frames.map(f => {

      for (const s of keyed(f.swap || [])) {

        cur[s.sk] = s.sprite;
        map[s.sk] = s.sprite;
      }

      return {
        f,
        dur: Math.max(1, f.dur || 1),
        sprites: { ...cur },
        items: keyed(f.items.filter(it => it.x !== undefined))
      };
    });

    // ---- 2. nei frame con cambio di frammento il file non rielenca i pezzi che cambiano
    // solo disegno (es. il cerchio sotto l'unita'): sparirebbero per un frame. Quei pezzi
    // stanno dove sono nel frame dopo (o dove erano prima, se dopo non ci sono).
    recs.forEach((rec, i) => {

      if (!rec.f.swap || !rec.items.length) return;

      const near = (step) => {

        for (let j = i + step; j >= 0 && j < recs.length; j += step) {

          if (recs[j].items.length) return new Map(recs[j].items.map(e => [e.sk, e]));
        }

        return new Map();
      };

      const prev = near(-1);
      const next = near(1);

      const have = new Set(rec.items.map(e => e.sk));
      const hid = new Set(rec.f.hide || []);

      for (const sw of keyed(rec.f.swap)) {

        if (have.has(sw.sk) || hid.has(sw.slot)) continue;

        const q = next.get(sw.sk) || prev.get(sw.sk);

        if (q) rec.items.push(q);
      }
    });

    // ---- 3. righe di pezzi
    const frames = recs.map((rec) => {

      // Ordine di disegno = numero dello slot (il 1 e' il fondo: l'ombra). I frame dove qualcosa
      // cambia elencano prima i pezzi che cambiano, e l'ombra finirebbe davanti al resto.
      // (Se in un file i frame normali non sono in ordine di slot, si tiene l'ordine del file.)
      const items = zBySlot
        ? rec.items
          .map((it, i) => ({ it, i }))
          .sort((a, b) => (a.it.slot - b.it.slot) || (a.i - b.i))
          .map(e => e.it)
        : rec.items;

      const pieces = [];

      // gli elementi sono dal fondo al davanti; nell'app il primo pezzo e' quello davanti
      for (let i = items.length - 1; i >= 0; i--) {

        const it = items[i];

        const sp = sprites[rec.sprites[it.sk]];

        if (!sp || sp.sx === undefined) continue;

        const opacity = it.color !== undefined ? (it.color >>> 24) / 255 * 100 : 100;

        if (opacity < 0.5) continue;

        pieces.push({
          sam: true,
          slot: it.slot,
          sk: it.sk,
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

      return { pieces, dur: rec.dur, key: rowKey(pieces) };
    });

    // l'animazione di morte non serve: non si offre (ma i suoi cambi di frammento valgono lo stesso)
    if (SKIP_ANIM.test(animName)) { skipped.push(animName); continue; }

    const seq = [];

    for (const f of cleanFrames(frames)) {

      framesDB.push(f.pieces);

      seq.push({ id: framesDB.length - 1, xOffset: 0, yOffset: 0, duration: f.dur });
    }

    if (!seq.length) continue;

    let k = key;

    while (sequences[k]) k += '_2';

    sequences[k] = seq;
    labels[k] = animName;
    names.push(k);
  }

  // ---- la croce (origine) sta ai piedi: al centro dell'ombra del primo frame,
  // come nelle unita' CGG. Tutto si sposta insieme, il movimento non cambia.
  const foot = footPoint(framesDB, sequences[names[0]]);

  if (foot) {

    for (const k of names) {

      for (const f of sequences[k]) { f.xOffset = -foot.x; f.yOffset = -foot.y; }
    }
  }

  return {
    atlas,
    framesDB,
    sequences,
    order: names,
    labels,
    missing,
    warnings: data.warnings || [],
    skipped,
    spriteCount: sprites.length
  };
}


// ------------------------------------------------------------
// FRAME PRINCIPALI
//
// Un .sam ha tantissimi frame (anche 200 per un attacco) perche' molti
// sono solo passaggi intermedi di un movimento. Con il "Morbido" l'app
// sa gia' creare i passaggi tra un frame e il successivo, quindi basta
// tenere i frame PRINCIPALI: un frame si toglie quando e' (entro una
// tolleranza in pixel) quello che verrebbe fuori interpolando i due
// frame che lo circondano. Il movimento resta lo stesso, con molti meno
// frame; i frame dove cambia il disegno (un altro ritaglio) restano
// tutti, perche' fra due disegni diversi non si puo' interpolare.
//
// La durata totale non cambia: ogni frame tenuto dura quanto il suo
// pezzo di tempo piu' quello dei frame tolti.
// ------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;

// differenza tra due angoli (radianti) per la via piu' corta
function angleDiff(a, b) {

  const full = Math.PI * 2;

  let d = (b - a) % full;

  if (d > Math.PI) d -= full;
  if (d < -Math.PI) d += full;

  return d;
}

const IDENTITY = [1, 0, 0, 1];

// quanto si sposta, al massimo, un pezzo del frame k rispetto alla via diretta a -> b (in pixel)
function deviation(pa, pk, pb, t) {

  // raggio del pezzo attorno all'origine: una rotazione piccola sposta di piu' gli angoli lontani
  const radius = Math.hypot(
    Math.max(Math.abs(pa.ox), Math.abs(pa.ox + pa.w)),
    Math.max(Math.abs(pa.oy), Math.abs(pa.oy + pa.h))
  );

  const ex = Math.abs(pk.x - lerp(pa.x, pb.x, t));
  const ey = Math.abs(pk.y - lerp(pa.y, pb.y, t));

  const er = Math.abs(angleDiff(pa.rad + angleDiff(pa.rad, pb.rad) * t, pk.rad)) * radius;

  const ma = pa.mat || IDENTITY;
  const mb = pb.mat || IDENTITY;
  const mk = pk.mat || IDENTITY;

  let em = 0;

  for (let i = 0; i < 4; i++) {
    em = Math.max(em, Math.abs(mk[i] - lerp(ma[i], mb[i], t)));
  }

  // 5% di opacita' contano come 1 pixel
  const eo = Math.abs((pk.opacity ?? 100) - lerp(pa.opacity ?? 100, pb.opacity ?? 100, t)) * 0.2;

  return Math.max(ex, ey, er, em * radius, eo);
}

export function reduceSamSequence(sequence, framesDB, tolerance) {

  const n = sequence.length;

  if (!(tolerance > 0) || n < 3) return sequence;

  const rows = sequence.map(f => framesDB[f.id] || []);

  // "forma" di un frame: quali ritagli, nello stesso ordine
  const shape = rows.map(r => r.map(p => `${p.sk},${p.sx},${p.sy},${p.w},${p.h},${p.blendMode || 0}`).join('|'));

  const dur = sequence.map(f => Math.max(1, Number(f.duration) || 1));

  const anchors = [0];

  let a = 0;

  while (a < n - 1) {

    let best = a + 1;

    for (let b = a + 2; b < n; b++) {

      if (shape[b] !== shape[a]) break;

      let total = 0;

      for (let k = a; k < b; k++) total += dur[k];

      let ok = true;
      let elapsed = 0;

      for (let k = a + 1; k < b && ok; k++) {

        elapsed += dur[k - 1];

        if (shape[k] !== shape[a]) { ok = false; break; }

        const t = elapsed / total;

        for (let j = 0; j < rows[k].length; j++) {

          if (deviation(rows[a][j], rows[k][j], rows[b][j], t) > tolerance) { ok = false; break; }
        }
      }

      if (!ok) break;

      best = b;
    }

    anchors.push(best);

    a = best;
  }

  return anchors.map((start, i) => {

    const end = i + 1 < anchors.length ? anchors[i + 1] : n;

    let duration = 0;

    for (let k = start; k < end; k++) duration += dur[k];

    return { ...sequence[start], duration };
  });
}