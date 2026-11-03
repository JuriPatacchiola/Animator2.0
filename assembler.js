// ============================================================
// EDITOR DI ASSEMBLAGGIO
//
// Serve per le unita' che hanno solo i file CGS e lo sheet ma NON il
// CGG. Lo sheet contiene i pezzi separati: qui li si dispone frame per
// frame e si esporta un CGG compatibile con il resto del progetto.
//
// Formato di una riga CGG (uguale al gioco):
//   frameId, numPezzi, poi per ogni pezzo 11 valori:
//   x, y, flip, blend, opacita%, rotazione, sx, sy, w, h, pagina
// Il primo pezzo e' quello in primo piano (si disegna dal fondo).
// ============================================================

import { Parser } from './parser.js';
import { Renderer } from './renderer.js';

const $ = id => document.getElementById(id);

const STORE = 'animator.assembler.';

const S = {
    img: null,            // HTMLImageElement dello sheet
    name: '',             // nome file dello sheet (chiave di salvataggio)
    alpha: null,          // Uint8ClampedArray RGBA dello sheet
    rects: [],            // pezzi rilevati {sx,sy,w,h}
    frames: [],           // frames[i] = array di pezzi CGG
    cur: 0,
    sel: -1,              // pezzo "principale" (quello mostrato nel pannello)
    selSet: new Set(),    // tutti i pezzi selezionati (selezione multipla)
    hover: -1,            // pezzo sotto il mouse nell'elenco (si illumina nel frame)
    zoom: 3,
    panX: 0,
    panY: 0,
    onion: true,
    grid: true,
    drag: null,
    play: null,
    sheetZoom: 1.5,
    view: null,           // frame mostrati: id del CGG usati dall'animazione scelta (null = tutti)
    msg: ''               // avviso mostrato nel pannello (es. CGS mancante)
};

const SEQ_NAMES = { idle: 'Idle', move: 'Move', atk: 'Attack', all: 'Tutti' };


// ------------------------------------------------------------
// FRAME VISIBILI
//
// Scegliendo Idle / Move / Attack si lavora solo sui frame del CGG
// che quell'animazione usa davvero (nell'ordine in cui compaiono
// nel CGS, senza doppioni). "Tutti" mostra l'intero CGG.
// ------------------------------------------------------------

// ------------------------------------------------------------
// SELEZIONE (uno o piu' pezzi del frame corrente)
// ------------------------------------------------------------

function selected() {
    const f = S.frames[S.cur] || [];
    return [...S.selSet].filter(i => f[i]).sort((a, b) => a - b);
}

function clearSel() {
    S.selSet = new Set();
    S.sel = -1;
}

// ------------------------------------------------------------
// GRUPPI (Ctrl+G / Ctrl+Shift+G)
//
// Il CGG del gioco non conosce i gruppi: ogni pezzo puo' avere un
// campo "group" (un numero) che usa solo l'editor. L'esportazione
// del CGG lo ignora, il salvataggio automatico lo conserva.
// Cliccando un pezzo di un gruppo si seleziona tutto il gruppo;
// con Alt+clic si prende solo quel pezzo.
// ------------------------------------------------------------

function groupOf(i) {
    const p = (S.frames[S.cur] || [])[i];
    return p && p.group ? p.group : 0;
}

function membersOf(g) {
    const out = [];
    (S.frames[S.cur] || []).forEach((p, i) => { if (p.group === g) out.push(i); });
    return out;
}

// indici con i gruppi completati: se c'e' un pezzo di un gruppo, ci sono tutti
function withGroups(indices) {
    const out = new Set(indices);
    for (const i of indices) {
        const g = groupOf(i);
        if (g) membersOf(g).forEach(j => out.add(j));
    }
    return out;
}

function nextGroupId() {
    let m = 0;
    for (const fr of S.frames) for (const p of fr) if (p.group > m) m = p.group;
    return m + 1;
}

// numeri di gruppo nuovi per delle copie (incolla / duplica): non si
// mescolano con il gruppo originale
function regroup(copies) {
    const map = new Map();
    let n = nextGroupId();
    for (const p of copies) {
        if (!p.group) continue;
        if (!map.has(p.group)) map.set(p.group, n++);
        p.group = map.get(p.group);
    }
}

const GROUP_COLORS = ['#34d399', '#f472b6', '#fb923c', '#a78bfa', '#22d3ee', '#facc15', '#f87171', '#4ade80'];

function groupColor(g) {
    return GROUP_COLORS[(g - 1) % GROUP_COLORS.length];
}

function groupSelected() {
    const f = S.frames[S.cur];
    const ids = selected();
    if (ids.length < 2) {
        S.msg = 'Per fare un gruppo seleziona almeno 2 pezzi';
        updatePanel();
        return;
    }
    const g = nextGroupId();
    ids.forEach(i => { f[i].group = g; });
    S.msg = `Creato il gruppo ${g} (${ids.length} pezzi)`;
    refresh();
}

function ungroupSelected() {
    const f = S.frames[S.cur];
    const ids = [...withGroups(selected())];
    let n = 0;
    ids.forEach(i => { if (f[i].group) { delete f[i].group; n++; } });
    S.msg = n ? `Gruppo sciolto (${n} pezzi)` : 'I pezzi selezionati non sono in un gruppo';
    refresh();
}


// single = true (Alt): solo quel pezzo, anche se e' in un gruppo
function selectOnly(i, single = false) {
    S.selSet = i >= 0 ? (single ? new Set([i]) : withGroups([i])) : new Set();
    S.sel = i;
}

function toggleSel(i, single = false) {
    const ids = single ? [i] : [...withGroups([i])];
    if (S.selSet.has(i)) {
        ids.forEach(j => S.selSet.delete(j));
        if (!S.selSet.has(S.sel)) { const r = selected(); S.sel = r.length ? r[r.length - 1] : -1; }
    } else {
        ids.forEach(j => S.selSet.add(j));
        S.sel = i;
    }
}

// ------------------------------------------------------------
// COPIA / TAGLIA / INCOLLA
//
// Si incolla con le STESSE coordinate (x, y, rotazione...) che i
// pezzi avevano nel frame da cui sono stati copiati: copi dal frame
// 3, vai al frame 4, incolli, e stanno esattamente nello stesso punto.
// ------------------------------------------------------------

let clipboard = [];

function copySelected() {
    const f = S.frames[S.cur];
    const ids = selected();
    if (!ids.length) return false;
    clipboard = ids.map(i => ({ ...f[i] }));      // in ordine di livello
    S.msg = `Copiati ${clipboard.length} pezzi (frame ${S.cur})`;
    return true;
}

function cutSelected() {
    if (!copySelected()) return;
    const n = clipboard.length;
    removeSelected();
    S.msg = `Tagliati ${n} pezzi`;
    updatePanel();
}

// behind = false: sopra tutti (primo piano) · true: sotto tutti (fondo)
function paste(behind = false) {
    if (!clipboard.length) {
        S.msg = 'Niente da incollare: seleziona dei pezzi e premi Ctrl+C';
        updatePanel();
        return;
    }
    const f = S.frames[S.cur];
    const copies = clipboard.map(p => ({ ...p }));
    regroup(copies);
    const at = behind ? f.length : 0;
    f.splice(at, 0, ...copies);
    S.selSet = new Set(copies.map((_, k) => at + k));
    S.sel = at;
    S.msg = '';
    refresh();
}


function selectAll() {
    const f = S.frames[S.cur] || [];
    S.selSet = new Set(f.map((_, i) => i));
    S.sel = f.length ? 0 : -1;
}

// rettangolo (assi dritti) che contiene il pezzo, anche se ruotato
function pieceBox(p) {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const a = (Number(p.rotate) || 0) * Math.PI / 180;
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const hw = (p.w * c + p.h * s) / 2, hh = (p.w * s + p.h * c) / 2;
    return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}

// pezzi dentro il rettangolo trascinato: interi dentro, oppure (Alt) anche solo toccati
function piecesInBox(d, touch) {
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
    const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    const out = [];
    (S.frames[S.cur] || []).forEach((p, i) => {
        const b = pieceBox(p);
        const ok = touch
            ? (b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1)
            : (b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1);
        if (ok) out.push(i);
    });
    return out;
}


function viewIds() {
    return S.view || S.frames.map((_, i) => i);
}

function posOf(id) {
    return viewIds().indexOf(id);
}

// frame che viene prima di quello corrente NELL'ANIMAZIONE scelta
function prevInView() {
    const ids = viewIds();
    const p = posOf(S.cur);
    return p > 0 ? ids[p - 1] : -1;
}

async function setView(name) {

    stopPlay();
    S.msg = '';

    if (name === 'all') {

        S.view = null;

    } else {

        const seq = await readSeq(name);

        if (!seq.length) {

            S.view = null;
            $('asmSeq').value = 'all';
            S.msg = `Il CGS di ${SEQ_NAMES[name]} non è caricato: mostro tutti i frame.`;

        } else {

            const ids = [];

            for (const q of seq) {
                const id = Math.max(0, Math.round(q.id));
                if (!ids.includes(id)) ids.push(id);
            }

            // il CGS puo' chiedere frame che il CGG non ha ancora: li creo vuoti
            const max = Math.max(...ids);
            while (S.frames.length <= max) S.frames.push([]);
            $('asmFrameNum').max = S.frames.length - 1;

            S.view = ids;
        }
    }

    const ids = viewIds();
    S.cur = ids.includes(S.cur) ? S.cur : (ids[0] || 0);
    clearSel();
    refresh();
}


// ------------------------------------------------------------
// RILEVAMENTO DEI PEZZI (componenti connesse sul canale alpha)
// ------------------------------------------------------------

export function detectRects(data, W, H, gap = 0) {

    const lab = new Int32Array(W * H);
    const out = [];
    const solid = i => data[i * 4 + 3] > 8;
    const stack = [];
    let n = 0;

    for (let s = 0; s < W * H; s++) {

        if (lab[s] || !solid(s)) continue;

        n++;
        lab[s] = n;
        stack.push(s);

        let x0 = W, y0 = H, x1 = 0, y1 = 0;

        while (stack.length) {

            const p = stack.pop();
            const px = p % W, py = (p / W) | 0;

            if (px < x0) x0 = px;
            if (px > x1) x1 = px;
            if (py < y0) y0 = py;
            if (py > y1) y1 = py;

            for (let dy = -1 - gap; dy <= 1 + gap; dy++) {
                for (let dx = -1 - gap; dx <= 1 + gap; dx++) {

                    const nx = px + dx, ny = py + dy;

                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;

                    const q = ny * W + nx;

                    if (!lab[q] && solid(q)) {
                        lab[q] = n;
                        stack.push(q);
                    }
                }
            }
        }

        out.push({ sx: x0, sy: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }

    // ordine di lettura: dall'alto, poi da sinistra
    out.sort((a, b) => (a.sy - b.sy) || (a.sx - b.sx));

    return out;
}


// ------------------------------------------------------------
// CGG <-> TESTO
// ------------------------------------------------------------

export function framesToCGG(frames) {

    return frames.map((pieces, id) => {

        const v = [id, pieces.length];

        for (const p of pieces) {
            v.push(
                p.x, p.y, p.flipType, p.blendMode, p.opacity,
                p.rotate, p.sx, p.sy, p.w, p.h, p.pageId || 0
            );
        }

        return v.join(',') + ',';

    }).join('\n') + '\n';
}


function newPiece(r) {
    return {
        x: -Math.round(r.w / 2),
        y: -Math.round(r.h / 2),
        flipType: 0, blendMode: 0, opacity: 100, rotate: 0,
        sx: r.sx, sy: r.sy, w: r.w, h: r.h, pageId: 0
    };
}


// ------------------------------------------------------------
// SALVATAGGIO AUTOMATICO (il lavoro non va perso se si chiude)
// ------------------------------------------------------------

function key() { return STORE + S.name + '.' + S.img.width + 'x' + S.img.height; }

function save() {
    try {
        localStorage.setItem(key(), JSON.stringify({ frames: S.frames, rects: S.rects }));
    } catch (e) { /* senza storage si lavora comunque */ }
}

function load() {
    try {
        const t = localStorage.getItem(key());
        return t ? JSON.parse(t) : null;
    } catch (e) { return null; }
}


// ------------------------------------------------------------
// GEOMETRIA
// ------------------------------------------------------------

function toLocal(p, wx, wy) {
    // punto del frame -> coordinate locali del pezzo (centro = 0,0).
    // Il disegno fa: flip, poi rotate(-a). L'inverso: flip, poi rotate(+a).
    let x = wx - (p.x + p.w / 2);
    let y = wy - (p.y + p.h / 2);
    const f = Number(p.flipType) || 0;
    // (nel disegno la matrice e' F*R(-a): l'inverso e' R(a)*F)
    const a = (Number(p.rotate) || 0) * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const rx = x * c - y * s;
    const ry = x * s + y * c;
    return {
        x: rx * ((f === 1 || f === 3) ? -1 : 1),
        y: ry * ((f === 2 || f === 3) ? -1 : 1)
    };
}

function hit(p, wx, wy) {
    const l = toLocal(p, wx, wy);
    if (Math.abs(l.x) > p.w / 2 || Math.abs(l.y) > p.h / 2) return false;
    const px = Math.min(p.w - 1, Math.max(0, Math.floor(l.x + p.w / 2)));
    const py = Math.min(p.h - 1, Math.max(0, Math.floor(l.y + p.h / 2)));
    const X = p.sx + px, Y = p.sy + py;
    return S.alpha[(Y * S.img.width + X) * 4 + 3] > 8;
}

function pickAt(wx, wy) {
    const f = S.frames[S.cur];
    for (let i = 0; i < f.length; i++) {      // 0 = primo piano
        if (hit(f[i], wx, wy)) return i;
    }
    return -1;
}


// ------------------------------------------------------------
// DISEGNO DEL FRAME
// ------------------------------------------------------------

const cv = () => $('asmCanvas');

function resizeCanvas() {
    const c = cv(), r = c.parentElement.getBoundingClientRect();
    c.width = Math.max(10, Math.floor(r.width));
    c.height = Math.max(10, Math.floor(r.height));
}

function view(ctx) {
    const c = cv();
    ctx.translate(c.width / 2 + S.panX, c.height / 2 + S.panY);
    ctx.scale(S.zoom, S.zoom);
}

function screenToWorld(ev) {
    const c = cv(), r = c.getBoundingClientRect();
    const sx = (ev.clientX - r.left) * (c.width / r.width);
    const sy = (ev.clientY - r.top) * (c.height / r.height);
    return {
        x: (sx - c.width / 2 - S.panX) / S.zoom,
        y: (sy - c.height / 2 - S.panY) / S.zoom
    };
}

function drawFrame() {

    const c = cv(), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#1a1d24';
    ctx.fillRect(0, 0, c.width, c.height);

    ctx.save();
    view(ctx);
    ctx.imageSmoothingEnabled = false;

    if (S.grid) {
        ctx.lineWidth = 1 / S.zoom;
        ctx.strokeStyle = '#2f3542';
        const ext = 400;
        for (let g = -ext; g <= ext; g += 16) {
            ctx.beginPath(); ctx.moveTo(g, -ext); ctx.lineTo(g, ext); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(-ext, g); ctx.lineTo(ext, g); ctx.stroke();
        }
        ctx.strokeStyle = '#ff5d5d';
        ctx.beginPath(); ctx.moveTo(-ext, 0); ctx.lineTo(ext, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, -ext); ctx.lineTo(0, ext); ctx.stroke();
    }

    // frame precedente in trasparenza (aiuta a ritoccare invece di rifare)
    // (il precedente dell'animazione scelta, non quello con l'id prima)
    const prev = prevInView();
    if (S.onion && prev >= 0 && !S.play) {
        ctx.globalAlpha = 0.3;
        Renderer.drawPieces(ctx, S.frames[prev], 0, 0);
        ctx.globalAlpha = 1;
    }

    const shown = S.play ? S.play.frame : S.cur;
    const f = S.frames[shown] || [];
    Renderer.drawPieces(ctx, f, 0, 0);

    // pezzi selezionati: giallo il principale, azzurro gli altri
    if (!S.play) {
        for (const i of selected()) {
            const p = f[i];
            ctx.save();
            ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
            const fl = Number(p.flipType) || 0;
            ctx.scale((fl === 1 || fl === 3) ? -1 : 1, (fl === 2 || fl === 3) ? -1 : 1);
            ctx.rotate(-(Number(p.rotate) || 0) * Math.PI / 180);
            ctx.strokeStyle = i === S.sel ? '#ffd400' : '#38bdf8';
            ctx.lineWidth = 1.5 / S.zoom;
            ctx.setLineDash([4 / S.zoom, 3 / S.zoom]);
            ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }
    }

    // gruppi con almeno un pezzo selezionato: riquadro colorato attorno a tutto il gruppo
    if (!S.play) {
        const groups = new Set(selected().map(groupOf).filter(g => g));
        for (const g of groups) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const i of membersOf(g)) {
                const b = pieceBox(f[i]);
                x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
                x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
            }
            const pad = 3 / S.zoom * 2;
            ctx.save();
            ctx.strokeStyle = groupColor(g);
            ctx.lineWidth = 1.5 / S.zoom;
            ctx.setLineDash([6 / S.zoom, 3 / S.zoom]);
            ctx.strokeRect(x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2);
            ctx.setLineDash([]);
            ctx.font = `bold ${11 / S.zoom}px sans-serif`;
            ctx.fillStyle = groupColor(g);
            ctx.fillText('Gruppo ' + g, x0 - pad, y0 - pad - 3 / S.zoom);
            ctx.restore();
        }
    }

    // pezzo sotto il mouse nell'elenco: contorno magenta e area attorno scurita
    if (!S.play && S.hover >= 0 && f[S.hover]) {
        const p = f[S.hover];
        ctx.save();
        ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
        const fl = Number(p.flipType) || 0;
        ctx.scale((fl === 1 || fl === 3) ? -1 : 1, (fl === 2 || fl === 3) ? -1 : 1);
        ctx.rotate(-(Number(p.rotate) || 0) * Math.PI / 180);
        ctx.fillStyle = 'rgba(232, 121, 249, 0.25)';
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.strokeStyle = '#e879f9';
        ctx.lineWidth = 2 / S.zoom;
        ctx.setLineDash([]);
        ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
    }

    // rettangolo di selezione mentre si trascina
    if (S.drag && S.drag.type === 'box') {
        const d = S.drag;
        ctx.save();
        ctx.lineWidth = 1 / S.zoom;
        ctx.setLineDash([]);
        ctx.strokeStyle = '#38bdf8';
        ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
        const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
    }

    ctx.restore();

    const ids = viewIds();
    $('asmFrameLabel').textContent = S.view
        ? `${SEQ_NAMES[$('asmSeq').value]}: ${ids.indexOf(shown) + 1} / ${ids.length}  ·  frame CGG n° ${shown}  ·  ${f.length} pezzi`
        : `Frame ${shown} / ${S.frames.length - 1}  ·  ${f.length} pezzi`;
}


function drawSheet() {

    const c = $('asmSheet'), ctx = c.getContext('2d');
    const z = S.sheetZoom;
    c.width = S.img.width * z;
    c.height = S.img.height * z;

    ctx.fillStyle = '#1a1d24';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(S.img, 0, 0, c.width, c.height);

    ctx.font = '11px sans-serif';
    S.rects.forEach((r, i) => {
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.strokeRect(r.sx * z + 0.5, r.sy * z + 0.5, r.w * z, r.h * z);
        ctx.fillStyle = '#ffd400';
        ctx.fillText(String(i), r.sx * z + 2, r.sy * z + 11);
    });

    if (S.sheetDrag) {
        const d = S.sheetDrag;
        ctx.strokeStyle = '#34d399';
        ctx.strokeRect(
            Math.min(d.x0, d.x1) * z, Math.min(d.y0, d.y1) * z,
            Math.abs(d.x1 - d.x0) * z, Math.abs(d.y1 - d.y0) * z
        );
    }
}


function refresh() {
    drawFrame();
    drawSheet();
    updatePanel();
    save();
}


// ------------------------------------------------------------
// PANNELLO DEL PEZZO SELEZIONATO
// ------------------------------------------------------------

const FIELDS = ['x', 'y', 'rotate', 'opacity', 'flipType', 'blendMode'];

function updatePanel() {

    const p = S.frames[S.cur][S.sel];

    $('asmPiece').style.opacity = p ? 1 : 0.4;

    FIELDS.forEach(k => {
        const el = $('asmP_' + k);
        el.disabled = !p;
        if (p && document.activeElement !== el) el.value = p[k];
    });

    const nSel = selected().length;
    const selGroups = [...new Set(selected().map(groupOf))];
    const oneGroup = selGroups.length === 1 && selGroups[0] && membersOf(selGroups[0]).length === nSel;

    $('asmPieceInfo').textContent = (nSel && S.msg ? S.msg + '  ·  ' : '') + (nSel > 1
        ? (oneGroup ? `Gruppo ${selGroups[0]} · ` : '') +
        `${nSel} pezzi selezionati  ·  Canc li elimina tutti  ·  i campi qui sotto cambiano tutti i selezionati`
        : p
            ? `Pezzo ${S.sel + 1}/${S.frames[S.cur].length}  ·  sheet ${p.sx},${p.sy}  ${p.w}×${p.h}`
            : (S.msg || 'Nessun pezzo selezionato (clicca un pezzo nel frame)'));

    $('asmPaste').textContent = clipboard.length ? `📥 Incolla (${clipboard.length})` : '📥 Incolla';

    $('asmSelCount').textContent = `${nSel} / ${S.frames[S.cur].length} selezionati`;
    $('asmDelSel').disabled = !nSel;

    $('asmFrameNum').value = S.cur;

    // striscia con i soli frame dell'animazione scelta
    const strip = $('asmStrip');
    strip.innerHTML = '';
    viewIds().forEach((id, i) => {
        const b = document.createElement('button');
        b.textContent = S.view ? `${i + 1}·#${id}` : String(id);
        b.title = `Frame CGG n° ${id} (${(S.frames[id] || []).length} pezzi)`;
        b.className = 'asm-chip' + (id === S.cur ? ' on' : '') + ((S.frames[id] || []).length ? '' : ' empty');
        b.onclick = () => goFrame(id);
        strip.appendChild(b);
    });
    const on = strip.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    // elenco pezzi del frame, con la miniatura di ognuno
    const list = $('asmList');
    const pieces = S.frames[S.cur];
    const chipClass = i => 'asm-chip asm-thumb' + (S.selSet.has(i) ? ' on' : '') + (i === S.sel && nSel > 1 ? ' main' : '');

    // se i pezzi sono gli stessi (es. mentre si trascina) aggiorno solo
    // evidenziazione e coordinate, senza ricreare tutte le miniature
    const sig = S.cur + '|' + pieces.map(p => pieceSig(p) + 'g' + (p.group || 0)).join(';');
    if (list.dataset.sig === sig) {
        [...list.children].forEach((b, i) => {
            b.className = chipClass(i);
            b.title = chipTitle(pieces[i], i);
        });
        return;
    }
    list.dataset.sig = sig;

    S.hover = -1;           // gli indici possono essere cambiati
    list.innerHTML = '';
    pieces.forEach((q, i) => {
        const b = document.createElement('button');
        b.className = chipClass(i);
        b.title = chipTitle(q, i);

        const im = document.createElement('img');
        im.src = thumbFor(q);
        im.alt = '';
        im.draggable = false;
        const n = document.createElement('span');
        n.textContent = `${i + 1}`;
        b.append(im, n);

        // pezzo in un gruppo: bordo colorato e etichetta "G3"
        if (q.group) {
            const c = groupColor(q.group);
            b.style.borderColor = c;
            b.style.borderWidth = '2px';
            const g = document.createElement('em');
            g.textContent = 'G' + q.group;
            g.style.background = c;
            b.appendChild(g);
        }

        // passando sopra, il pezzo si illumina nel frame
        b.onmouseenter = () => { S.hover = i; drawFrame(); };
        b.onmouseleave = () => { if (S.hover === i) { S.hover = -1; drawFrame(); } };

        // clic = solo questo (o il suo gruppo) · Ctrl/Cmd+clic = aggiungi/togli ·
        // Shift+clic = dal principale fino a qui · Alt = ignora il gruppo
        b.onclick = e => {
            if (e.ctrlKey || e.metaKey) {
                toggleSel(i, e.altKey);
            } else if (e.shiftKey && S.sel >= 0) {
                const a = Math.min(S.sel, i), z = Math.max(S.sel, i);
                const range = [];
                for (let k = a; k <= z; k++) range.push(k);
                (e.altKey ? new Set(range) : withGroups(range)).forEach(k => S.selSet.add(k));
                S.sel = i;
            } else {
                selectOnly(i, e.altKey);
            }
            refresh();
        };
        list.appendChild(b);
    });
}


// ------------------------------------------------------------
// MINIATURE DEI PEZZI (una per ritaglio dello sheet, poi riusata)
// ------------------------------------------------------------

const THUMB = 40;
const thumbCache = new Map();

function pieceSig(p) {
    return [p.sx, p.sy, p.w, p.h, p.flipType || 0].join(',');
}

function chipTitle(q, i) {
    return `Pezzo ${i + 1} · x ${q.x}, y ${q.y} · ${q.w}×${q.h}` +
        ((Number(q.rotate) || 0) ? ` · ruotato ${q.rotate}°` : '') +
        ((Number(q.blendMode) || 0) === 1 ? ' · luce' : '');
}

function thumbFor(p) {
    const key = S.name + '|' + pieceSig(p);
    if (thumbCache.has(key)) return thumbCache.get(key);

    const c = document.createElement('canvas');
    c.width = THUMB;
    c.height = THUMB;
    const ctx = c.getContext('2d');

    // ingrandisce i pezzi piccoli (pixel netti), rimpicciolisce quelli grandi
    const k = Math.min((THUMB - 4) / p.w, (THUMB - 4) / p.h, 6);
    const w = p.w * k, h = p.h * k;
    ctx.imageSmoothingEnabled = k < 1;

    const fl = Number(p.flipType) || 0;
    ctx.translate(THUMB / 2, THUMB / 2);
    ctx.scale((fl === 1 || fl === 3) ? -1 : 1, (fl === 2 || fl === 3) ? -1 : 1);
    ctx.drawImage(S.img, p.sx, p.sy, p.w, p.h, -w / 2, -h / 2, w, h);

    const url = c.toDataURL();
    thumbCache.set(key, url);
    return url;
}


function bindPanel() {

    // con piu' pezzi selezionati: X, Y e rotazione spostano tutti della
    // stessa quantita'; opacita', specchio e fusione diventano uguali per tutti
    const RELATIVE = ['x', 'y', 'rotate'];

    FIELDS.forEach(k => {
        $('asmP_' + k).addEventListener('input', e => {
            const f = S.frames[S.cur];
            const p = f[S.sel];
            if (!p) return;
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            const ids = selected();
            if (RELATIVE.includes(k)) {
                const d = v - (Number(p[k]) || 0);
                ids.forEach(i => { f[i][k] = (Number(f[i][k]) || 0) + d; });
                if (!ids.includes(S.sel)) p[k] = v;
            } else {
                ids.forEach(i => { f[i][k] = v; });
                p[k] = v;
            }
            drawFrame(); save();
        });
    });
}


function nudge(k, d) {
    const f = S.frames[S.cur];
    const ids = selected();
    if (!ids.length) return;
    ids.forEach(i => { f[i][k] = (Number(f[i][k]) || 0) + d; });
    refresh();
}


// sposta i selezionati di un livello (d = -1 verso il primo piano, +1 verso il fondo)
function moveLayer(d) {
    const f = S.frames[S.cur];
    const ids = selected();
    if (!ids.length) return;

    const order = d < 0 ? ids : ids.slice().reverse();
    const moved = new Map();       // vecchio indice -> nuovo
    const taken = new Set();

    for (const i of order) {
        const j = i + d;
        if (j < 0 || j >= f.length || taken.has(j)) {
            moved.set(i, i);
            taken.add(i);
            continue;
        }
        [f[i], f[j]] = [f[j], f[i]];
        moved.set(i, j);
        taken.add(j);
    }

    S.selSet = new Set(moved.values());
    S.sel = moved.has(S.sel) ? moved.get(S.sel) : -1;
    refresh();
}


function removeSelected() {
    const f = S.frames[S.cur];
    const ids = selected();
    if (!ids.length) return;
    for (let k = ids.length - 1; k >= 0; k--) f.splice(ids[k], 1);
    clearSel();
    refresh();
}


function duplicatePiece() {
    const f = S.frames[S.cur];
    const ids = selected();
    if (!ids.length) return;
    // le copie vanno davanti al primo selezionato e diventano la nuova selezione
    const copies = ids.map(i => ({ ...f[i], x: f[i].x + 4, y: f[i].y + 4 }));
    regroup(copies);
    f.splice(ids[0], 0, ...copies);
    S.selSet = new Set(copies.map((_, k) => ids[0] + k));
    S.sel = ids[0];
    refresh();
}


// avanti / indietro dentro l'animazione scelta
function step(d) {
    stopPlay();
    const ids = viewIds();
    if (!ids.length) return;
    const p = posOf(S.cur);
    S.cur = ids[Math.max(0, Math.min(ids.length - 1, p < 0 ? 0 : p + d))];
    clearSel();
    refresh();
}

// salto a un frame del CGG per numero
function goFrame(id) {
    stopPlay();
    S.cur = Math.max(0, Math.min(S.frames.length - 1, id));
    // se non fa parte dell'animazione scelta, mostro tutti i frame
    if (S.view && !S.view.includes(S.cur)) {
        S.view = null;
        $('asmSeq').value = 'all';
    }
    S.msg = '';
    clearSel();
    refresh();
}


function copyFrom(i) {
    if (i < 0 || i >= S.frames.length || i === S.cur) return;
    S.frames[S.cur] = S.frames[i].map(p => ({ ...p }));
    clearSel();
    refresh();
}


// ------------------------------------------------------------
// ANTEPRIMA CON I TEMPI DEL CGS
// ------------------------------------------------------------

async function readSeq(name) {
    const f = $(name) && $(name).files[0];
    return f ? Parser.parseCGS(await f.text()) : [];
}

function stopPlay() {
    if (S.play) { cancelAnimationFrame(S.play.raf); S.play = null; }
    $('asmPlay').textContent = '▶ Anteprima';
}

async function startPlay() {

    if (S.play) { stopPlay(); drawFrame(); return; }

    const name = $('asmSeq').value;
    const seq = name === 'all' ? [] : await readSeq(name);

    if (!seq.length) {
        $('asmPieceInfo').textContent = name === 'all'
            ? 'Per l\'anteprima scegli Idle, Move o Attack.'
            : 'Carica prima il file CGS di questa animazione.';
        return;
    }

    const st = { frame: 0, i: 0, t: performance.now(), raf: 0 };
    S.play = st;
    $('asmPlay').textContent = '⏹ Ferma';

    const step = now => {
        if (S.play !== st) return;
        const q = seq[st.i];
        st.frame = Math.min(S.frames.length - 1, q.id);
        if (now - st.t >= (q.duration || 1) * 1000 / 60) {
            st.t = now;
            st.i = (st.i + 1) % seq.length;
        }
        drawFrame();
        st.raf = requestAnimationFrame(step);
    };

    st.raf = requestAnimationFrame(step);
}


// ------------------------------------------------------------
// EVENTI MOUSE
// ------------------------------------------------------------

function bindCanvas() {

    const c = cv();

    c.addEventListener('contextmenu', e => e.preventDefault());

    c.addEventListener('mousedown', e => {

        if (S.play) return;

        const w = screenToWorld(e);

        if (e.button === 1 || e.button === 2) {
            S.drag = { type: 'pan', mx: e.clientX, my: e.clientY, px: S.panX, py: S.panY };
            return;
        }

        const i = pickAt(w.x, w.y);
        const f = S.frames[S.cur];
        const multi = e.ctrlKey || e.metaKey || e.shiftKey;

        if (i >= 0) {

            if (e.ctrlKey || e.metaKey) {
                toggleSel(i, e.altKey);
                if (!S.selSet.has(i)) { refresh(); return; }   // appena tolto: niente trascinamento
            } else if (e.shiftKey) {
                (e.altKey ? new Set([i]) : withGroups([i])).forEach(j => S.selSet.add(j));
                S.sel = i;
            } else if (e.altKey) {
                selectOnly(i, true);             // Alt: solo questo pezzo, anche dentro un gruppo
            } else if (!S.selSet.has(i)) {
                selectOnly(i);
            } else {
                S.sel = i;                       // gia' selezionato: si trascina tutto il gruppo
            }

            S.drag = {
                type: 'pieces', sx: w.x, sy: w.y,
                start: selected().map(j => ({ j, x: f[j].x, y: f[j].y }))
            };

        } else {

            // area vuota: rettangolo di selezione (con Ctrl/Shift si aggiunge)
            if (!multi) clearSel();
            S.drag = { type: 'box', x0: w.x, y0: w.y, x1: w.x, y1: w.y, base: new Set(S.selSet) };
        }

        refresh();
    });

    window.addEventListener('mousemove', e => {

        const d = S.drag;
        if (!d) return;

        if (d.type === 'pan') {
            const r = c.getBoundingClientRect();
            const k = c.width / r.width;
            S.panX = d.px + (e.clientX - d.mx) * k;
            S.panY = d.py + (e.clientY - d.my) * k;
            drawFrame();
        } else if (d.type === 'box') {
            const w = screenToWorld(e);
            d.x1 = w.x;
            d.y1 = w.y;
            const hit = piecesInBox(d, e.altKey);
            S.selSet = new Set([...d.base, ...withGroups(hit)]);
            S.sel = hit.length ? hit[0] : (d.base.size ? [...d.base][0] : -1);
            drawFrame();
            updatePanel();
        } else {
            const w = screenToWorld(e);
            const f = S.frames[S.cur];
            const dx = Math.round(w.x - d.sx), dy = Math.round(w.y - d.sy);
            for (const s of d.start) {
                if (!f[s.j]) continue;
                f[s.j].x = s.x + dx;
                f[s.j].y = s.y + dy;
            }
            drawFrame();
            updatePanel();
        }
    });

    window.addEventListener('mouseup', () => {
        if (S.drag) { S.drag = null; drawFrame(); save(); }
    });

    c.addEventListener('wheel', e => {
        e.preventDefault();
        if (e.altKey && S.sel >= 0) {
            nudge('rotate', e.deltaY < 0 ? 5 : -5);
            return;
        }
        S.zoom = Math.max(0.5, Math.min(16, S.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        drawFrame();
    }, { passive: false });
}


function bindSheet() {

    const c = $('asmSheet');

    c.addEventListener('contextmenu', e => {
        e.preventDefault();
        const p = sheetPoint(e);
        const i = S.rects.findIndex(r =>
            p.x >= r.sx && p.x < r.sx + r.w && p.y >= r.sy && p.y < r.sy + r.h);
        if (i >= 0) { S.rects.splice(i, 1); refresh(); }
    });

    function sheetPoint(e) {
        const r = c.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (c.width / r.width) / S.sheetZoom,
            y: (e.clientY - r.top) * (c.height / r.height) / S.sheetZoom
        };
    }

    c.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const p = sheetPoint(e);
        if (e.shiftKey) {                       // rettangolo manuale
            S.sheetDrag = { x0: Math.round(p.x), y0: Math.round(p.y), x1: Math.round(p.x), y1: Math.round(p.y) };
            return;
        }
        // click: aggiunge il pezzo al frame (il piu' piccolo che contiene il punto)
        const cand = S.rects
            .filter(r => p.x >= r.sx && p.x < r.sx + r.w && p.y >= r.sy && p.y < r.sy + r.h)
            .sort((a, b) => a.w * a.h - b.w * b.h)[0];
        if (!cand) return;
        S.frames[S.cur].unshift(newPiece(cand));
        selectOnly(0);
        refresh();
    });

    window.addEventListener('mousemove', e => {
        if (!S.sheetDrag) return;
        const p = sheetPoint(e);
        S.sheetDrag.x1 = Math.round(p.x);
        S.sheetDrag.y1 = Math.round(p.y);
        drawSheet();
    });

    window.addEventListener('mouseup', () => {
        const d = S.sheetDrag;
        if (!d) return;
        S.sheetDrag = null;
        const x0 = Math.max(0, Math.min(d.x0, d.x1)), y0 = Math.max(0, Math.min(d.y0, d.y1));
        const x1 = Math.min(S.img.width, Math.max(d.x0, d.x1)), y1 = Math.min(S.img.height, Math.max(d.y0, d.y1));
        if (x1 - x0 >= 2 && y1 - y0 >= 2) {
            S.rects.push({ sx: x0, sy: y0, w: x1 - x0, h: y1 - y0 });
        }
        refresh();
    });
}


// ------------------------------------------------------------
// APERTURA / CHIUSURA
// ------------------------------------------------------------

async function maxFrameFromCGS() {
    let m = -1;
    for (const n of ['idle', 'atk', 'move']) {
        for (const q of await readSeq(n)) m = Math.max(m, q.id);
    }
    return m + 1;
}


function loadImg(file) {
    return new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('Immagine non valida'));
        im.src = URL.createObjectURL(file);
    });
}


export async function openAssembler() {

    const file = $('img').files[0];

    if (!file) {
        alert('Carica prima l\'immagine (sheet) dell\'unità.');
        return;
    }

    S.img = await loadImg(file);
    S.name = file.name;
    thumbCache.clear();               // lo sheet puo' essere cambiato
    $('asmList').dataset.sig = '';
    Renderer.image = S.img;       // il disegno dei pezzi usa questa immagine

    const t = document.createElement('canvas');
    t.width = S.img.width; t.height = S.img.height;
    const tc = t.getContext('2d', { willReadFrequently: true });
    tc.drawImage(S.img, 0, 0);
    S.alpha = tc.getImageData(0, 0, t.width, t.height).data;

    const saved = load();
    const n = Math.max(await maxFrameFromCGS(), 1);

    S.rects = saved && saved.rects.length ? saved.rects : detectRects(S.alpha, t.width, t.height);
    S.frames = saved ? saved.frames : [];

    while (S.frames.length < n) S.frames.push([]);

    S.cur = 0; clearSel(); S.panX = 0; S.panY = 0;

    $('asmOverlay').style.display = 'flex';
    $('asmFrameNum').max = S.frames.length - 1;

    resizeCanvas();

    // parto dall'animazione scelta nella pagina principale (se ha il CGS)
    const main = $('select').value;
    let start = 'all';
    if (['idle', 'move', 'atk'].includes(main) && $(main).files[0]) start = main;
    else start = ['idle', 'move', 'atk'].find(n => $(n).files[0]) || 'all';

    $('asmSeq').value = start;
    await setView(start);
}


function closeAssembler() {
    stopPlay();
    save();
    $('asmOverlay').style.display = 'none';
}


function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}


function useInAnimator() {

    const text = framesToCGG(S.frames);
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'unit_cgg_costruito.csv', { type: 'text/csv' }));
    $('cgg').files = dt.files;

    closeAssembler();
    $('start').click();
}


export function initAssembler() {

    $('openAssembler').onclick = openAssembler;
    $('asmClose').onclick = closeAssembler;

    $('asmPrev').onclick = () => step(-1);
    $('asmNext').onclick = () => step(1);
    $('asmFrameNum').onchange = e => goFrame(Number(e.target.value) || 0);
    $('asmSeq').onchange = e => setView(e.target.value);

    $('asmCopyPrev').onclick = () => copyFrom(prevInView());
    $('asmCopyFrom').onclick = () => copyFrom(Number($('asmCopySrc').value));
    $('asmClear').onclick = () => { S.frames[S.cur] = []; clearSel(); refresh(); };

    $('asmFront').onclick = () => moveLayer(-1);
    $('asmBack').onclick = () => moveLayer(1);
    $('asmDup').onclick = duplicatePiece;
    $('asmDel').onclick = removeSelected;
    $('asmDelSel').onclick = removeSelected;
    $('asmGroup').onclick = groupSelected;
    $('asmUngroup').onclick = ungroupSelected;
    $('asmCopy').onclick = () => { copySelected(); updatePanel(); };
    $('asmCut').onclick = cutSelected;
    $('asmPaste').onclick = e => paste(e.shiftKey);
    $('asmSelAll').onclick = () => { selectAll(); refresh(); };
    $('asmSelNone').onclick = () => { clearSel(); refresh(); };

    $('asmRotM').onclick = () => nudge('rotate', -Number($('asmStep').value));
    $('asmRotP').onclick = () => nudge('rotate', Number($('asmStep').value));

    $('asmOnion').onchange = e => { S.onion = e.target.checked; drawFrame(); };
    $('asmGrid').onchange = e => { S.grid = e.target.checked; drawFrame(); };

    $('asmPlay').onclick = startPlay;

    $('asmRedetect').onclick = () => {
        S.rects = detectRects(S.alpha, S.img.width, S.img.height, Number($('asmGap').value) || 0);
        refresh();
    };

    $('asmExport').onclick = () =>
        download('unit_cgg_costruito.csv', framesToCGG(S.frames));

    $('asmImport').onchange = async e => {
        const f = e.target.files[0];
        if (!f) return;
        const db = Parser.parseCGG(await f.text());
        S.frames = db.map(p => p.map(q => ({ ...q })));
        while (S.frames.length < Number($('asmFrameNum').max) + 1) S.frames.push([]);
        $('asmFrameNum').max = S.frames.length - 1;
        S.cur = -1;
        await setView($('asmSeq').value);
        e.target.value = '';
    };

    $('asmUse').onclick = useInAnimator;

    bindPanel();
    bindCanvas();
    bindSheet();

    window.addEventListener('resize', () => {
        if ($('asmOverlay').style.display !== 'none') { resizeCanvas(); drawFrame(); }
    });

    window.addEventListener('keydown', e => {

        if ($('asmOverlay').style.display === 'none') return;

        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag === 'INPUT' || tag === 'SELECT') return;

        const k = e.key;
        const px = e.shiftKey ? 5 : 1;

        const ctrl = e.ctrlKey || e.metaKey;
        const lk = k.toLowerCase();

        if (ctrl && lk === 'g') { e.shiftKey ? ungroupSelected() : groupSelected(); e.preventDefault(); }
        else if (ctrl && lk === 'a') { selectAll(); refresh(); e.preventDefault(); }
        else if (ctrl && lk === 'c') { copySelected(); updatePanel(); e.preventDefault(); }
        else if (ctrl && lk === 'x') { cutSelected(); e.preventDefault(); }
        else if (ctrl && lk === 'v') { paste(e.shiftKey); e.preventDefault(); }
        else if (k === 'ArrowLeft') { nudge('x', -px); e.preventDefault(); }
        else if (k === 'ArrowRight') { nudge('x', px); e.preventDefault(); }
        else if (k === 'ArrowUp') { nudge('y', -px); e.preventDefault(); }
        else if (k === 'ArrowDown') { nudge('y', px); e.preventDefault(); }
        else if (k === 'Delete' || k === 'Backspace') { removeSelected(); e.preventDefault(); }
        else if (k === ',') step(-1);
        else if (k === '.') step(1);
        else if (k === '[') moveLayer(1);
        else if (k === ']') moveLayer(-1);
        else if (k === 'q') nudge('rotate', -Number($('asmStep').value));
        else if (k === 'e') nudge('rotate', Number($('asmStep').value));
        else if (k === 'Escape') {
            // prima toglie la selezione, al secondo Esc chiude
            if (S.selSet.size) { clearSel(); refresh(); } else closeAssembler();
        }
    });
}