import { createAPNGWriter, createZipWriter } from './apng.js';
import { animFromName, APNG_LIBRARY, buildApngUnit, clampSplit, decodeApng, expandLinks, fetchApngs, guessDefaultSplit, isApng, proxyLooksWrong, sliceDefault, unitIdFromNames } from './apngimport.js';
import { initAssembler } from './assembler.js';
import { EK, Eraser } from './eraser.js';
import { createGifWriter, createPaletteBuilder } from './gif.js';
import { Parser } from './parser.js';
import { Renderer } from './renderer.js';
import { buildSamUnit, reduceSamSequence } from './sam.js';
import {
    composeFrame,
    computeGroundShifts,
    findShadowKeys,
    frameDuration,
    pieceKey,
    sampleSequence,
    sequenceBounds,
    sequenceTotalTicks,
    setSamSoft,
    TICK_MS
} from './smoothing.js';
import { encodeWebmAlpha, inspectWebm } from './webm.js';
import { encodeAnimatedWebp, inspectWebp } from './webp.js';


// ============================================================
// ZOOM
// ============================================================

let ZOOM_LEVEL = 0.2;

// diventa true quando i campi dell'area esistono (serve a saveView)
let uiReady = false;

/*
    Zoom e posizione restano come li hai lasciati: non si azzerano piu'
    ad "AVVIA", al cambio di animazione o di file. Si ricordano anche
    se ricarichi la pagina. Per tornare al centro c'e' "Reset vista".
*/

const VIEW_KEY = 'animator.view';

function saveView() {

    try {

        localStorage.setItem(VIEW_KEY, JSON.stringify({
            zoom: ZOOM_LEVEL,
            x: Renderer.offsetX,
            y: Renderer.offsetY
        }));

    } catch (e) { /* storage non disponibile: pazienza */ }

    if (uiReady) updateExportInfo();

    const label = document.getElementById('zoomLabel');

    if (label) label.innerText = `Zoom ${Math.round(ZOOM_LEVEL * 100)}%`;
}


// ============================================================
// STATO
// ============================================================

const state = {

    sequences: {
        idle: [],
        atk: [],
        move: [],
        all: []
    },

    // animazioni dell'unita' caricata (nomi interni, nell'ordine): idle, move, atk
    // per i file CGG / CGS, quelle del file per un .sam (Idle, Move, Attack, Dead...)
    animNames: ['idle', 'move', 'atk'],

    // true se l'unita' viene da un file .sam (frammenti PNG, niente CGG)
    samMode: false,

    // true se l'unita' e' stata ricostruita da APNG (un disegno intero per fotogramma)
    imported: false,

    // numero dell'unita' (dai nomi dei file importati), serve ai nomi dei file salvati
    unitId: '',

    // .sam: sequenze complete del file e nomi mostrati (state.sequences ha quelle ridotte ai frame principali)
    samFull: {},
    samLabels: {},

    // .sam: ritagli (pieceKey) che fanno da ombra: il pezzo piatto sempre sotto a tutto
    samShadowKeys: null,

    // durata di 1 tick in millisecondi: 1/60 s per i file CGG / CGS; per un .sam si
    // sceglie dal cursore "Velocita' .sam" (anteprima ed esportazioni usano lo stesso valore)
    tickMs: TICK_MS,

    // CGG cosi' com'e' nel file e CGG in uso (con l'ombra aggiunta dove manca)
    framesDBOrig: [],
    framesDB: [],

    // spostamento per frame che tiene fermo il punto d'appoggio
    shifts: [],

    current: 'idle',

    frameIndex: 0,

    isPlaying: false,

    isPaused: false,

    lastTime: 0,

    // tick (1/60 s) trascorsi nel frame corrente
    ticks: 0,

    // tempo accumulato che non ha ancora formato un tick intero
    accum: 0,

    currentFrameDuration: 1,

    downloadCount: 1,

    // passaggio morbido tra i frame
    smooth: true,

    // personaggio fermo a terra
    lock: true
};


// strumenti dell'importazione APNG sull'anteprima: 'feet' (un clic sui piedi) / 'cut' (rettangolo da togliere)
const apngPick = { mode: null, drag: null, pointer: null };


// ============================================================
// INIT RENDERER
// ============================================================

Renderer.init('cv');

// dopo un ridimensionamento della finestra il canvas si svuota: ridisegno subito
Renderer.onResize = () => { updateExportInfo(); renderCurrentFrame(); };

try {

    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');

    if (v && Number.isFinite(v.zoom) && v.zoom > 0) {

        ZOOM_LEVEL = v.zoom;
        Renderer.scale = v.zoom;
        Renderer.offsetX = Number(v.x) || 0;
        Renderer.offsetY = Number(v.y) || 0;
    }

} catch (e) { /* ignoro */ }

saveView();


// ============================================================
// ELEMENTI UI
// ============================================================

const timeline =
    document.getElementById('timeline');

const frameCounter =
    document.getElementById('frameCounter');

const btnPause =
    document.getElementById('togglePause');

const selectAnim =
    document.getElementById('select');

const btnStart =
    document.getElementById('start');

const btnImage =
    document.getElementById('downloadImage');

const btnGif =
    document.getElementById('downloadGif');

const btnApng =
    document.getElementById('downloadApng');

const btnVideo =
    document.getElementById('downloadVideo');

const btnZip =
    document.getElementById('downloadZip');

const btnWebp =
    document.getElementById('downloadWebp');

const btnSite =
    document.getElementById('downloadSite');

document.getElementById('resetView').onclick = () => {

    ZOOM_LEVEL = 0.2;

    Renderer.scale = ZOOM_LEVEL;

    Renderer.offsetX = 0;
    Renderer.offsetY = 0;

    saveView();

    renderCurrentFrame();
};

const chkSmooth =
    document.getElementById('smooth');

const chkLock =
    document.getElementById('lock');



// ============================================================
// ANIMAZIONE COMPLETA: idle + move + atk uno dopo l'altro
// (solo quelle caricate), ognuna ripetuta N volte
// ============================================================

const repeatInputs = {
    idle: document.getElementById('repIdle'),
    move: document.getElementById('repMove'),
    atk: document.getElementById('repAtk')
};

function rebuildAll() {

    const all = [];

    for (const name of state.animNames) {

        const seq = state.sequences[name];

        if (!seq || seq.length === 0) continue;

        // le ripetizioni si scelgono solo per idle / move / atk; le altre (Dead...) una volta
        const n = repeatInputs[name]
            ? Math.max(0, Math.min(20, parseInt(repeatInputs[name].value, 10) || 0))
            : 1;

        for (let r = 0; r < n; r++) all.push(...seq);
    }

    state.sequences.all = all;
}

function fileLabel() {

    // nome dei file esportati: l'animazione completa si chiama "default"
    return state.current === 'all' ? 'default' : state.current;
}

Object.values(repeatInputs).forEach(el => el.addEventListener('change', () => {

    rebuildAll();

    if (state.current === 'all') {

        state.frameIndex = 0;
        state.ticks = 0;
        state.accum = 0;

        updateTimelineUI();
        renderCurrentFrame();
    }
}));


// ============================================================
// OPZIONI: MORBIDO / BLOCCA A TERRA
// ============================================================

chkSmooth.addEventListener(
    'change',
    () => {

        state.smooth = chkSmooth.checked;

        saveExportPrefs();

        refreshSamInfo();

        chkSmooth.blur();

        renderCurrentFrame();
    }
);


// "Blocca a terra" ricorda la scelta di ogni formato: nei CGG di solito serve (le righe
// hanno ritagli diversi e l'unita' scivolerebbe), nei .sam lo spostamento dell'ombra e'
// quello vero del gioco (uno scatto in avanti), quindi li' parte spenta
const lockPref = { cgg: true, sam: false };

function applyLockPref() {

    const v = lockPref[state.samMode ? 'sam' : 'cgg'];

    chkLock.checked = v;
    state.lock = v;
}

chkLock.addEventListener(
    'change',
    () => {

        state.lock = chkLock.checked;

        lockPref[state.samMode ? 'sam' : 'cgg'] = chkLock.checked;

        saveExportPrefs();

        chkLock.blur();

        renderCurrentFrame();
    }
);


function activeShifts() {

    return state.lock ? state.shifts : null;
}


// ============================================================
// OMBRA A TERRA SE MANCA
//
// Le unita' che fluttuano hanno l'ombra nel gioco, ma nel CGG molte
// righe (spesso tutte quelle dell'idle) non hanno il pezzo ombra. Si
// prende l'ombra che l'unita' ha gia' in altre righe (ritaglio, posizione
// e opacita' piu' comuni) e si aggiunge come ultimo pezzo, cioe' sotto
// tutto, alle righe che ne sono senza. Il file CGG non viene toccato.
// ============================================================

const chkAutoShadow = document.getElementById('autoShadow');

function withMissingShadows(db) {

    const isShadow = makeShadowTest();

    const stat = new Map();

    for (const pieces of db) {

        for (const p of pieces || []) {

            if (!isShadow(p)) continue;

            const key = p.sx + ',' + p.sy + ',' + p.w + ',' + p.h;

            let e = stat.get(key);

            if (!e) stat.set(key, e = { p, n: 0, xs: [], ys: [], ops: [] });

            e.n++;
            e.xs.push(Number(p.x) || 0);
            e.ys.push(Number(p.y) || 0);
            e.ops.push(Number.isFinite(p.opacity) ? p.opacity : 100);
        }
    }

    // nessuna ombra in tutto il CGG: non c'e' niente da copiare
    if (!stat.size) return db;

    const best = [...stat.values()].sort((a, b) => b.n - a.n)[0];

    const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

    const template = {
        ...best.p,
        x: median(best.xs),
        y: median(best.ys),
        opacity: median(best.ops),
        rotate: 0,
        blendMode: 0
    };

    let added = 0;

    const out = db.map(pieces => {

        if (!pieces || !pieces.length || pieces.some(isShadow)) return pieces;

        added++;

        return [...pieces, { ...template }];
    });

    return added ? out : db;
}

function applyAutoShadow() {

    if (!state.framesDBOrig.length) return;

    // un'unita' da APNG ha gia' tutto nel disegno (ombra compresa): niente ombra aggiunta
    state.framesDB = (chkAutoShadow.checked && !state.imported)
        ? withMissingShadows(state.framesDBOrig)
        : state.framesDBOrig;

    // ogni pezzo riceve la sua chiave "riga:numero" (serve alla gomma)
    Eraser.tag(state.framesDB);
}

chkAutoShadow.addEventListener(
    'change',
    () => {

        applyAutoShadow();

        // .sam: i frame principali si scelgono guardando i pezzi, che ora sono cambiati
        if (state.samMode) {

            applySamReduce();

            state.frameIndex = 0;
            state.ticks = 0;
            state.accum = 0;

            updateTimelineUI();
        }

        saveExportPrefs();

        chkAutoShadow.blur();

        renderCurrentFrame();

        updateExportInfo();
    }
);


// ============================================================
// ZOOM CON ROTELLA MOUSE
// ============================================================

Renderer.canvas.addEventListener(
    'wheel',
    (event) => {

        event.preventDefault();


        if (event.deltaY > 0) {

            ZOOM_LEVEL =
                Math.max(
                    0.02,
                    ZOOM_LEVEL - 0.05
                );

        } else {

            ZOOM_LEVEL += 0.05;
        }


        Renderer.scale = ZOOM_LEVEL;

        saveView();


        /*
            Ridisegniamo sempre il frame corrente,
            non solamente quando l'animazione è in play.
        */

        renderCurrentFrame();
    }
);


// ============================================================
// PAN
// ============================================================

let isDragging = false;


Renderer.canvas.addEventListener(
    'mousedown',
    (event) => {

        // con la gomma accesa (o con "Segna i piedi" / "Togli il logo") il tasto sinistro / destro e' dello strumento:
        // la vista si sposta col tasto centrale
        if ((Eraser.on || apngPick.mode) && event.button !== 1) {
            return;
        }

        if (Eraser.on || apngPick.mode) event.preventDefault();

        isDragging = true;
    }
);


window.addEventListener(
    'mouseup',
    () => {

        isDragging = false;
    }
);


window.addEventListener(
    'mousemove',
    (event) => {

        if (!isDragging) {
            return;
        }


        Renderer.offsetX +=
            event.movementX;

        Renderer.offsetY +=
            event.movementY;

        saveView();


        renderCurrentFrame();
    }
);


// ============================================================
// GOMMA (cancella pixel)
//
// Pennello sull'anteprima. Le cancellazioni sono maschere (vedi eraser.js):
// i file originali non cambiano e valgono in tutte le esportazioni.
// ============================================================

const ERASER_KEY = 'animator.eraser';

const eraserUI = {
    toggle: document.getElementById('eraserToggle'),
    opts: document.getElementById('eraserOpts'),
    size: document.getElementById('eraserSize'),
    sizeNum: document.getElementById('eraserSizeNum'),
    scope: document.getElementById('eraserScope'),
    top: document.getElementById('eraserTop'),
    undo: document.getElementById('eraserUndo'),
    redo: document.getElementById('eraserRedo'),
    clearFrame: document.getElementById('eraserClearFrame'),
    clearAll: document.getElementById('eraserClearAll'),
    info: document.getElementById('eraserInfo')
};

// pointer = dove sta il mouse (coordinate dell'animatore); drawing = tratto in corso
const eraserState = { pointer: null, drawing: null, note: '' };

try {

    const v = JSON.parse(localStorage.getItem(ERASER_KEY) || 'null');

    if (v) {

        if (v.size >= 1 && v.size <= 40) Eraser.size = Math.round(v.size);
        if (v.scope === 'frame' || v.scope === 'sheet') Eraser.scope = v.scope;
        Eraser.topOnly = !!v.top;
    }

} catch (e) { /* ignoro */ }

eraserUI.size.value = Eraser.size;
eraserUI.sizeNum.value = Eraser.size;
eraserUI.scope.value = Eraser.scope;
eraserUI.top.checked = Eraser.topOnly;

function eraserSave() {

    try {

        localStorage.setItem(ERASER_KEY, JSON.stringify({ size: Eraser.size, scope: Eraser.scope, top: Eraser.topOnly }));

    } catch (e) { /* ignoro */ }
}

function eraserSetSize(v) {

    Eraser.size = Math.max(1, Math.min(40, Math.round(Number(v) || 1)));

    eraserUI.size.value = Eraser.size;
    eraserUI.sizeNum.value = Eraser.size;

    eraserSave();

    renderCurrentFrame();
}

eraserUI.size.addEventListener('input', () => eraserSetSize(eraserUI.size.value));
eraserUI.sizeNum.addEventListener('change', () => eraserSetSize(eraserUI.sizeNum.value));

eraserUI.scope.addEventListener('change', () => {

    Eraser.scope = eraserUI.scope.value;

    eraserSave();

    eraserRefresh();

    eraserUI.scope.blur();
});

eraserUI.top.addEventListener('change', () => {

    Eraser.topOnly = eraserUI.top.checked;

    eraserSave();

    eraserUI.top.blur();
});

// riga del file e fotogramma mostrato adesso
function eraserFrame() {

    const sequence = state.sequences[state.current];

    if (!sequence || !sequence.length) return null;

    const f = sequence[state.frameIndex];

    return f ? { id: f.id, n: state.frameIndex + 1, of: sequence.length } : null;
}

// pezzi del fotogramma esatto che si vede (il primo e' quello in primo piano)
function eraserPieces() {

    const sequence = state.sequences[state.current];

    if (!sequence || !sequence.length) return null;

    return composeFrame({
        sequence,
        framesDB: state.framesDB,
        shifts: activeShifts(),
        index: state.frameIndex,
        t: 0,
        smooth: false
    });
}

// punto del mouse nelle coordinate dell'animatore (come le disegna Renderer.draw)
function eraserWorld(ev) {

    const cv = Renderer.canvas;

    const r = cv.getBoundingClientRect();

    const dx = (ev.clientX - r.left) * (cv.width / r.width);
    const dy = (ev.clientY - r.top) * (cv.height / r.height);

    const k = Renderer.scale * Renderer.dpr;

    return {
        x: (dx - cv.width / 2 - Renderer.offsetX * Renderer.dpr) / k,
        y: (dy - cv.height / 2 - Renderer.offsetY * Renderer.dpr) / k
    };
}

const eraserRunning = () => state.isPlaying && !state.isPaused;

function eraserRefresh() {

    eraserUI.undo.disabled = !Eraser.canUndo;
    eraserUI.redo.disabled = !Eraser.canRedo;

    const st = Eraser.stats();

    const fr = eraserFrame();

    const here = fr ? Eraser.countInRow(fr.id) : 0;

    eraserUI.clearFrame.disabled = !here;
    eraserUI.clearAll.disabled = !(st.sheet || st.inst);

    const lines = [];

    if (Eraser.on) {

        if (fr) lines.push(`Fotogramma ${fr.n} / ${fr.of} (riga ${fr.id} del file)${here ? ` · ${here} pixel cancellati qui` : ''}`);

        if (eraserRunning()) lines.push('⏸ Metti in pausa per cancellare (qui sotto il pulsante PAUSA).');

        if (Renderer.scale < 1) lines.push(`🔍 Zoom ${Math.round(Renderer.scale * 100)}%: ingrandisci con la rotella per colpire pixel precisi.`);

        if (Eraser.scope === 'sheet') lines.push('⚠ «Tutto il foglio»: il pixel sparisce da tutti i fotogrammi che lo usano.');
    }

    if (st.sheet || st.inst) {

        const parts = [];

        if (st.inst) parts.push(`${st.inst} pixel in ${st.frames} fotogramm${st.frames === 1 ? 'a' : 'i'}`);
        if (st.sheet) parts.push(`${st.sheet} pixel sul foglio`);

        lines.push(`Cancellati: ${parts.join(' + ')} (valgono anche nelle esportazioni).`);
    }

    if (Eraser.saveError) lines.push('⚠ Non riesco a salvare le cancellazioni nel browser: restano finché non chiudi la pagina.');

    if (eraserState.note) lines.push(eraserState.note);

    eraserUI.info.textContent = lines.join('\n');
}

Eraser.onChange = () => {

    eraserRefresh();

    renderCurrentFrame();
};

function eraserApplyUI() {

    eraserUI.toggle.textContent = Eraser.on ? '🧽 Gomma: accesa (clic per spegnere)' : '🧽 Gomma: spenta';
    eraserUI.toggle.style.background = Eraser.on ? '#be123c' : '';
    eraserUI.toggle.style.borderColor = Eraser.on ? '#fb7185' : '';

    eraserUI.opts.style.display = Eraser.on ? 'flex' : 'none';

    Renderer.canvas.style.cursor = Eraser.on ? 'crosshair' : '';

    eraserRefresh();

    renderCurrentFrame();
}

eraserUI.toggle.onclick = () => {

    if (!Eraser.on) {

        const seq = state.sequences[state.current];

        if (!state.isPlaying || !seq || !seq.length) {

            alert("Carica un'unità e avvia l'animazione prima di usare la gomma.");

            return;
        }

        Eraser.on = true;

        // si lavora su un fotogramma fermo
        state.isPaused = true;

        btnPause.innerText = '▶ RIPRENDI';

    } else {

        Eraser.on = false;

        eraserState.pointer = null;
        eraserState.drawing = null;
    }

    eraserState.note = '';

    eraserApplyUI();
};

eraserUI.undo.onclick = () => { Eraser.undo(); };
eraserUI.redo.onclick = () => { Eraser.redo(); };

eraserUI.clearFrame.onclick = () => {

    const fr = eraserFrame();

    if (fr) Eraser.clearFrame(fr.id);
};

eraserUI.clearAll.onclick = () => { Eraser.clearAll(); };

// cerchio del pennello sullo schermo (non entra mai nelle esportazioni)
function drawEraserCursor() {

    if (!Eraser.on || !eraserState.pointer || !Renderer.ctx || state.hideOverlay) return;

    const ctx = Renderer.ctx;
    const cv = Renderer.canvas;

    const k = Renderer.scale * Renderer.dpr;

    const [cx, cy] = Eraser.snap(eraserState.pointer.x, eraserState.pointer.y);

    const r = Math.max(Math.max(1, Math.round(Eraser.size)) / 2, 4 / k);

    ctx.save();

    ctx.translate(cv.width / 2 + Renderer.offsetX * Renderer.dpr, cv.height / 2 + Renderer.offsetY * Renderer.dpr);
    ctx.scale(k, k);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);

    ctx.lineWidth = 3 / k;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.stroke();

    ctx.lineWidth = 1.5 / k;
    ctx.strokeStyle = eraserState.drawing && eraserState.drawing.restore ? '#34d399' : '#fb7185';
    ctx.stroke();

    ctx.restore();
}

Renderer.canvas.addEventListener('contextmenu', (ev) => { if (Eraser.on) ev.preventDefault(); });

Renderer.canvas.addEventListener('mousedown', (ev) => {

    if (!Eraser.on) return;

    // tasto centrale: sposta la vista (lo fa il codice del pan)
    if (ev.button === 1) { ev.preventDefault(); return; }

    ev.preventDefault();

    // il clic sul disegno non sposta il cursore da un eventuale campo di testo: lo togliamo noi,
    // altrimenti Ctrl+Z resterebbe "bloccato" dentro la casella della misura
    const ae = document.activeElement;

    if (ae && ae !== document.body && ae.tagName === 'INPUT' && ae.type !== 'range' && ae.type !== 'checkbox') ae.blur();

    if (eraserRunning()) {

        eraserState.note = '⏸ Metti in pausa per cancellare.';

        eraserRefresh();

        return;
    }

    eraserState.note = '';

    const pieces = eraserPieces();

    if (!pieces) return;

    const w = eraserWorld(ev);

    const restore = ev.button === 2 || ev.altKey;

    eraserState.drawing = { restore, last: w };
    eraserState.pointer = w;

    Eraser.beginStroke();

    Eraser.paint(pieces, w.x, w.y, restore);

    renderCurrentFrame();
});

window.addEventListener('mousemove', (ev) => {

    if (!Eraser.on) return;

    const over = ev.target === Renderer.canvas;

    if (!over && !eraserState.drawing) return;

    const w = eraserWorld(ev);

    const d = eraserState.drawing;

    if (d) {

        const pieces = eraserPieces();

        if (pieces) Eraser.stroke(pieces, d.last.x, d.last.y, w.x, w.y, d.restore);

        d.last = w;
    }

    eraserState.pointer = over ? w : null;

    if (!eraserRunning()) renderCurrentFrame();
});

Renderer.canvas.addEventListener('mouseleave', () => {

    if (!Eraser.on || eraserState.drawing) return;

    eraserState.pointer = null;

    if (!eraserRunning()) renderCurrentFrame();
});

window.addEventListener('mouseup', () => {

    if (!eraserState.drawing) return;

    eraserState.drawing = null;

    // chiude il tratto: da qui in poi si puo' annullare tutto il tratto in un colpo solo
    Eraser.endStroke();

    eraserRefresh();
});

window.addEventListener('keydown', (ev) => {

    if (!Eraser.on) return;

    const t = document.activeElement;

    if (t && ((t.tagName === 'INPUT' && ['text', 'number'].includes(t.type)) || t.tagName === 'TEXTAREA')) return;

    // niente scorciatoie se e' aperta un'altra finestra (editor, anteprima, controlli)
    for (const id of ['asmOverlay', 'fvOverlay', 'siteOverlay']) {

        const el = document.getElementById(id);

        if (el && el.style.display !== 'none') return;
    }

    const k = ev.key.toLowerCase();
    const ctrl = ev.ctrlKey || ev.metaKey;

    if (ctrl && k === 'z' && !ev.shiftKey) { Eraser.undo(); ev.preventDefault(); }
    else if (ctrl && (k === 'y' || (k === 'z' && ev.shiftKey))) { Eraser.redo(); ev.preventDefault(); }
    else if (!ctrl && k === '[') { eraserSetSize(Eraser.size - (ev.shiftKey ? 5 : 1)); }
    else if (!ctrl && k === ']') { eraserSetSize(Eraser.size + (ev.shiftKey ? 5 : 1)); }
});

// cambiando fotogramma / animazione / pausa si aggiorna il riquadro con i dati.
// Lo fa renderCurrentFrame (dopo che lo stato e' cambiato davvero): con un listener
// sul pulsante o sulla timeline si leggerebbe ancora il fotogramma precedente.
let eraserSyncKey = '';

function eraserSync() {

    if (!Eraser.on) { eraserSyncKey = ''; return; }

    const key = `${state.current}|${state.frameIndex}|${state.isPaused ? 1 : 0}|${state.isPlaying ? 1 : 0}`;

    if (key === eraserSyncKey) return;

    eraserSyncKey = key;

    eraserRefresh();
}

eraserRefresh();


// ============================================================
// FEEDBACK CARICAMENTO FILE
// ============================================================

document
    .querySelectorAll('input[type="file"]')
    .forEach(input => {

        input.addEventListener(
            'change',
            function () {

                if (this.files.length > 0) {

                    this.parentElement
                        .classList
                        .add('loaded');
                }
            }
        );
    });


// ============================================================
// CARICAMENTO MULTIPLO
//
// Un solo clic (o un trascinamento sulla pagina) per caricare
// insieme PNG, CGG e i CGS di idle / atk / move. Ogni file va nel
// suo posto in base al NOME:
//
//   .png / .jpg          -> immagine (sheet)
//   contiene "cgg"       -> struttura CGG
//   contiene "idle"      -> CGS Idle
//   contiene "atk"       -> CGS Attack  (anche "attack")
//   contiene "move"      -> CGS Move
//
// I pulsanti singoli restano com'erano.
// ============================================================

const SLOTS = ['img', 'cgg', 'idle', 'atk', 'move'];

const SLOT_LABEL = {
    img: 'PNG',
    cgg: 'CGG',
    idle: 'Idle',
    atk: 'Attack',
    move: 'Move'
};

const multiInfo = document.getElementById('multiInfo');

function slotFile(id) {

    return document.getElementById(id).files[0] || null;
}

function classifyFile(file) {

    const n = file.name.toLowerCase();

    if (/\.(png|jpe?g)$/.test(n)) return 'img';

    if (!/\.(csv|cgg|cgs|txt)$/.test(n)) return null;

    if (n.includes('cgg')) return 'cgg';
    if (n.includes('idle')) return 'idle';
    if (n.includes('atk') || n.includes('attack')) return 'atk';
    if (n.includes('move')) return 'move';

    return null;
}

// mette (o toglie, con null) un file in uno dei cinque posti
function setSlot(id, file) {

    const input = document.getElementById(id);

    const dt = new DataTransfer();

    if (file) dt.items.add(file);

    input.files = dt.files;

    input.parentElement.classList.toggle('loaded', !!file);
}

// elenco di cio' che e' caricato adesso (vale anche per i pulsanti singoli)
function showLoaded(notes = []) {

    if (!multiInfo) return;

    const lines = SLOTS.map(id => {

        const f = slotFile(id);

        return f ? `✔ ${SLOT_LABEL[id]}: ${f.name}` : `✖ ${SLOT_LABEL[id]}`;
    });

    multiInfo.innerText = lines.concat(notes).join('\n');
}

async function loadMany(fileList) {

    const files = [...fileList];

    guessUnitName(files);

    // animazioni APNG (unita' senza CGG / CGS / .sam)
    const apngs = await apngCandidates(files);

    if (apngs.length) {

        await loadApngFiles(apngs);

        return;
    }

    // un file .sam (con i suoi frammenti PNG): modo .sam
    if (files.some(f => /\.sam$/i.test(f.name))) {

        loadSamFiles(files);

        return;
    }

    const found = {};
    const doubles = [];
    const unknown = [];

    for (const f of files) {

        const slot = classifyFile(f);

        if (!slot) unknown.push(f.name);
        else if (found[slot]) doubles.push(f.name);
        else found[slot] = f;
    }

    const notes = [];

    if (Object.keys(found).length === 0) {

        showLoaded([`⚠ Nessun file riconosciuto (${files.map(f => f.name).join(', ') || 'vuoto'}). Il nome deve contenere cgg, idle, atk o move.`]);

        return;
    }

    /*
        Set completo di una nuova unita' (PNG + CGG + almeno un CGS):
        le animazioni che non ci sono (es. nessun Move) vengono svuotate,
        cosi' non resta quella dell'unita' di prima. Se invece ricarichi
        solo qualche file (per esempio il CGG appena ritoccato) gli
        altri restano dove sono.
    */

    const fullSet = found.img && found.cgg && (found.idle || found.atk || found.move);

    for (const id of SLOTS) {

        if (found[id]) setSlot(id, found[id]);
        else if (fullSet && ['idle', 'atk', 'move'].includes(id)) setSlot(id, null);
    }

    if (doubles.length) notes.push(`⚠ Uso il primo file per ogni tipo, ignorati: ${doubles.join(', ')}`);
    if (unknown.length) notes.push(`⚠ Non riconosciuti: ${unknown.join(', ')}`);

    showLoaded(notes);

    // con PNG, CGG e almeno un CGS parte da sola
    const ready = slotFile('img') && slotFile('cgg') && ['idle', 'atk', 'move'].some(n => slotFile(n));

    if (ready) btnStart.click();
}

document.getElementById('multiFiles').addEventListener('change', (event) => {

    loadMany(event.target.files);

    // si puo' riselezionare lo stesso gruppo di file
    event.target.value = '';

    event.target.parentElement.classList.remove('loaded');
});

// i pulsanti singoli aggiornano lo stesso elenco
SLOTS.forEach(id => document.getElementById(id).addEventListener('change', () => showLoaded()));

showLoaded();


// ---- trascinamento dei file sulla pagina ----

const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

const assemblerOpen = () => {

    const o = document.getElementById('asmOverlay');

    return o && o.style.display !== 'none';
};

window.addEventListener('dragover', (e) => {

    if (!hasFiles(e)) return;

    e.preventDefault();

    if (!assemblerOpen()) document.body.classList.add('drag-over');
});

window.addEventListener('dragleave', (e) => {

    // esce dalla finestra
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {

        document.body.classList.remove('drag-over');
    }
});

window.addEventListener('drop', (e) => {

    if (!hasFiles(e)) return;

    e.preventDefault();

    document.body.classList.remove('drag-over');

    if (assemblerOpen()) return;

    // si possono trascinare anche cartelle intere (un .sam con i suoi PNG)
    filesFromDrop(e.dataTransfer).then(list => loadMany(list));
});


// ============================================================
// CARICAMENTO DI UN'UNITA' .SAM
//
// Un .sam e i suoi frammenti PNG (si possono scegliere i file insieme,
// una cartella, o trascinarli sulla pagina). Se nel gruppo ci sono piu'
// .sam si carica il primo: i PNG di ogni frammento si cercano per nome,
// preferendo la cartella del .sam.
// ============================================================

const pathOf = (f) => f._path || f.webkitRelativePath || f.name;

// file di un trascinamento, cartelle comprese (le voci vanno lette subito, prima di qualsiasi await)
async function filesFromDrop(dt) {

    const entries = [];
    const out = [];

    for (const it of dt.items || []) {

        if (it.kind !== 'file') continue;

        const en = it.webkitGetAsEntry && it.webkitGetAsEntry();

        if (en) entries.push(en);
        else {
            const f = it.getAsFile();
            if (f) out.push(f);
        }
    }

    if (!entries.length && !out.length) return [...(dt.files || [])];

    const walk = async (en) => {

        try {

            if (en.isFile) {

                const file = await new Promise((ok, ko) => en.file(ok, ko));

                file._path = en.fullPath.replace(/^\//, '');

                out.push(file);

            } else if (en.isDirectory) {

                const reader = en.createReader();

                for (; ;) {

                    const batch = await new Promise((ok, ko) => reader.readEntries(ok, ko));

                    if (!batch.length) break;

                    for (const child of batch) await walk(child);
                }
            }

        } catch (e) { /* un file illeggibile non ferma gli altri */ }
    };

    for (const en of entries) await walk(en);

    return out;
}

async function loadSamFiles(files) {

    const sams = files.filter(f => /\.sam$/i.test(f.name));

    const samFile = sams[0];

    const entries = files
        .filter(f => /\.png$/i.test(f.name))
        .map(f => ({ file: f, path: pathOf(f) }));

    multiInfo.innerText = `Lettura di ${samFile.name} e di ${entries.length} PNG…`;

    try {

        const unit = await buildSamUnit(await samFile.arrayBuffer(), entries, pathOf(samFile));

        if (!unit.framesDB.length) throw new Error('nessun frame nel .sam');

        Renderer.image = unit.atlas;

        state.framesDBOrig = unit.framesDB;
        state.framesDB = unit.framesDB;

        // punto d'appoggio di ogni frame (l'ombra del .sam), come per il CGG
        state.shifts = computeGroundShifts(unit.framesDB);

        setSamMode(unit);

        rebuildAll();

        const notes = [];

        if (sams.length > 1) notes.push(`⚠ Carico solo il primo .sam, ignorati: ${sams.slice(1).map(f => f.name).join(', ')}`);

        if (unit.missing.length) notes.push(`⚠ Mancano ${unit.missing.length} PNG su ${unit.spriteCount} (es. ${unit.missing[0]}): quei pezzi non si vedono. Aggiungi la cartella che li contiene.`);

        if (unit.warnings.length) notes.push(`⚠ ${unit.warnings.length} frame del .sam non decodificati (es. ${unit.warnings[0]})`);

        // la gomma ritrova le cancellazioni gia' fatte su questa unita'
        Eraser.attach(Renderer.image, state.framesDBOrig, state.framesDB);

        eraserRefresh();

        apngRefresh();

        multiInfo.innerText = [
            `✔ SAM: ${samFile.name}`,
            `✔ ${unit.spriteCount - unit.missing.length} / ${unit.spriteCount} frammenti PNG`,
            'Animazioni: ' + unit.order.map(k => `${unit.labels[k]} ${unit.sequences[k].length}`).join(' · '),
            ...notes
        ].join('\n');

        state.downloadCount = 1;

        beginPlayback(unit.order);

    } catch (error) {

        console.error('Errore .sam:', error);

        multiInfo.innerText = `⚠ ${samFile.name}: ${error.message}`;
    }
}

// cartella intera (anche con sottocartelle)
const multiDir = document.getElementById('multiDir');

if (multiDir) {

    multiDir.addEventListener('change', (event) => {

        loadMany(event.target.files);

        event.target.value = '';

        event.target.parentElement.classList.remove('loaded');
    });
}


// ============================================================
// IMPORTA ANIMAZIONI APNG
//
// Per le unita' di cui esistono solo le animazioni gia' montate (APNG di
// idle / atk / move, per esempio dalla libreria del gioco): si scelgono i
// file, si trascinano sulla pagina o si scrive il numero dell'unita' / i
// link. Ogni fotogramma diventa un disegno intero dell'unita': si anima, si
// ritocca con la gomma e si esporta come tutte le altre. "Salva come unita'"
// li trasforma in PNG + CGG + CGS veri, da caricare quando vuoi.
// ============================================================

const apngEls = {
    files: document.getElementById('apngFiles'),
    links: document.getElementById('apngLinks'),
    fetch: document.getElementById('apngFetch'),
    proxy: document.getElementById('apngProxy'),
    info: document.getElementById('apngInfo'),
    save: document.getElementById('apngSave'),
    defaultPick: document.getElementById('apngDefault'),
    splitBox: document.getElementById('apngSplitBox'),
    strip: document.getElementById('apngStrip'),
    splitIdle: document.getElementById('splitIdle'),
    splitReps: document.getElementById('splitReps'),
    splitMove: document.getElementById('splitMove'),
    splitInfo: document.getElementById('apngSplitInfo'),
    feet: document.getElementById('apngFeet'),
    cut: document.getElementById('apngCut'),
    reset: document.getElementById('apngReset'),
    step: document.getElementById('apngStep'),
    nudge: [...document.querySelectorAll('[data-apng-nudge]')]
};

const APNG_PREF_KEY = 'animator.apng';

// posizione e logo: valgono per tutte le unita' importate (i fotogrammi della libreria sono fatti tutti uguali)
//   feet = punto dei piedi, misurato dal centro in basso del fotogramma {dx, dy}
//   cuts = rettangoli da togliere (logo, scritta), misurati dall'angolo in basso a sinistra {l, b, w, h}
const APNG_POS_KEY = 'animator.apngPos';

// preset = impostazioni automatiche della libreria (fotogrammi 640x400: piedi e logo a posto da soli)
const apngPos = { feet: null, cuts: [], preset: true };

try {

    const v = JSON.parse(localStorage.getItem(APNG_POS_KEY) || 'null');

    if (v) {

        if (v.feet && Number.isFinite(v.feet.dx) && Number.isFinite(v.feet.dy)) apngPos.feet = { dx: v.feet.dx, dy: v.feet.dy };

        if (v.preset === false) apngPos.preset = false;

        if (Array.isArray(v.cuts)) apngPos.cuts = v.cuts.filter(c => c && [c.l, c.b, c.w, c.h].every(Number.isFinite) && c.w > 0 && c.h > 0).slice(0, 12);
    }

} catch (e) { /* ignoro */ }

const apngIsLibrary = (w, h) => w === APNG_LIBRARY.w && h === APNG_LIBRARY.h;

// rettangoli da togliere e punto dei piedi per un fotogramma di w x h
const apngCutsFor = (w, h) => [...(apngPos.preset && apngIsLibrary(w, h) ? APNG_LIBRARY.cuts : []), ...apngPos.cuts];

const apngFeetFor = (w, h) => apngPos.feet || (apngPos.preset && apngIsLibrary(w, h) ? APNG_LIBRARY.feet : { dx: 0, dy: 0 });

function apngSavePos() {

    try { localStorage.setItem(APNG_POS_KEY, JSON.stringify(apngPos)); } catch (e) { /* ignoro */ }
}

// spostamento fatto a mano su ogni animazione (si vede e si salva con l'unita')
state.apngNudge = {};
state.apngFiles = [];

// default (un solo APNG con tutto): file, tagli scelti ({idleLen, idleReps, moveLen, user}) e fotogrammi per le miniature
state.apngDefaultFile = null;
state.apngSplit = null;
state.apngDefDec = null;
state.apngAnchors = {};
state.apngSizes = {};

try {

    const v = JSON.parse(localStorage.getItem(APNG_PREF_KEY) || 'null');

    if (v) {

        if (typeof v.links === 'string') apngEls.links.value = v.links;
        if (typeof v.proxy === 'string') apngEls.proxy.value = v.proxy;
    }

} catch (e) { /* ignoro */ }

function apngSavePrefs() {

    try {

        localStorage.setItem(APNG_PREF_KEY, JSON.stringify({ links: apngEls.links.value, proxy: apngEls.proxy.value.trim() }));

    } catch (e) { /* ignoro */ }
}

function apngSay(text) {

    apngEls.info.textContent = text;
}

// il pulsante "Salva come unita'" serve quando c'e' un'unita' CGG / APNG (non per i .sam)
function apngRefresh() {

    apngEls.save.disabled = state.samMode || !state.framesDBOrig.length || !Renderer.image;

    // posizione e logo servono solo alle unita' importate da APNG
    for (const el of [apngEls.feet, apngEls.cut, apngEls.reset, apngEls.step, ...apngEls.nudge]) el.disabled = !state.imported;

    if (!state.imported && apngPick.mode) apngDisarm();

    // i tagli del default si vedono solo finche' l'unita' viene da un default
    apngEls.splitBox.hidden = !(state.imported && state.apngDefaultFile && state.apngDefDec && state.apngSplit);
}

// quali file di un gruppo sono APNG (o PNG con il nome di un'animazione, senza CGG / CGS / .sam)
async function apngCandidates(files) {

    if (files.some(f => /\.(sam|csv|cgg|cgs|txt)$/i.test(f.name))) return [];

    const out = [];

    for (const f of files) {

        if (!/\.png$/i.test(f.name)) continue;

        let anim = false;

        try { anim = isApng(await f.arrayBuffer()); } catch (e) { /* illeggibile: non e' un APNG */ }

        if (anim || animFromName(f.name)) out.push(f);
    }

    return out;
}

async function loadApngFiles(files, extraNotes = [], opts = {}) {

    const notes = [...extraNotes];

    try {

        const found = {};

        // ogni file si legge una volta sola
        const decCache = new Map();

        const decodeOne = async (f) => {

            if (!decCache.has(f)) {

                apngSay(`Lettura di ${f.name}…`);

                decCache.set(f, await decodeApng(await f.arrayBuffer(), (n, m) => apngSay(`Lettura di ${f.name}: fotogramma ${n} / ${m}`), apngCutsFor));
            }

            return decCache.get(f);
        };

        for (const f of files) {

            let a = (opts.defaultFile && f === opts.defaultFile) ? 'default' : animFromName(f.name);

            // un solo file e il nome non dice cosa e': se ha l'idle ripetuto e poi altro e' un default, altrimenti e' l'idle
            if (!a && files.length === 1) {

                const probe = await decodeOne(f);

                const g = guessDefaultSplit(probe);

                if (g.repeated && probe.frames.length - g.idleLen * g.idleReps >= 2) {

                    a = 'default';

                    notes.push(`ℹ «${f.name}» ha l'idle ripetuto e poi altri fotogrammi: lo tratto come DEFAULT e lo taglio in idle / move / atk.`);

                } else {

                    a = 'idle';

                    notes.push(`ℹ «${f.name}» non dice se è idle, atk o move: lo uso come Idle.`);
                }
            }

            if (!a) { notes.push(`⚠ Non so che animazione sia «${f.name}» (il nome deve contenere idle, atk, move o default): ignorato.`); continue; }

            if (found[a]) { notes.push(`⚠ Due file per «${a}»: uso il primo, ignorato ${f.name}.`); continue; }

            found[a] = f;
        }

        if (!Object.keys(found).length) throw new Error('nessun file riconosciuto');

        // ---- default: idle / move / atk si ricavano da un solo APNG (i file separati, se ci sono, hanno la precedenza)
        const needDefault = !!found.default && ['idle', 'atk', 'move'].some(a => !found[a]);

        let split = null;
        let defDec = null;
        let sliced = null;

        if (found.default && !needDefault) notes.push('ℹ Ho già idle, atk e move separati: il default non serve.');

        if (needDefault) {

            defDec = await decodeOne(found.default);

            const guess = guessDefaultSplit(defDec);

            const mine = opts.keep && state.apngSplit;

            split = { ...clampSplit(mine || guess, defDec.frames.length), user: !!(mine && mine.user), repeated: guess.repeated, moveGuessed: !mine && guess.moveGuessed };

            sliced = sliceDefault(defDec, split);
        }

        const anims = [];

        for (const a of ['idle', 'atk', 'move']) {

            if (found[a]) {

                anims.push({ name: a, dec: await decodeOne(found[a]) });

            } else if (sliced && sliced[a] && sliced[a].frames.length) {

                anims.push({ name: a, dec: sliced[a] });
            }
        }

        if (!anims.length) throw new Error('nessun fotogramma da importare');

        const unit = buildApngUnit(anims, TICK_MS, apngFeetFor);

        // per rifare l'importazione (piedi, logo, tagli) senza chiedere di nuovo i file
        state.apngDefaultFile = needDefault ? found.default : null;
        state.apngSplit = split;
        state.apngDefDec = defDec;
        state.apngFiles = Object.values(found);
        state.apngAnchors = unit.anchors;
        state.apngSizes = unit.sizes;

        if (!opts.keep) state.apngNudge = {};

        // per riprendere dal punto in cui eri
        const resume = opts.keep ? { current: state.current, frameIndex: state.frameIndex, paused: state.isPaused } : null;

        // ---- l'unita' entra nell'animatore come un'unita' CGG
        Renderer.image = unit.atlas;

        setStandardMode();

        state.imported = true;

        state.unitId = unitIdFromNames(files.map(f => f.name));

        state.framesDBOrig = unit.framesDB;
        state.framesDB = unit.framesDB;

        // niente "blocco a terra" ne' ombra aggiunta: l'APNG e' gia' composto cosi'
        state.shifts = unit.framesDB.map(() => ({ x: 0, y: 0 }));

        state.lock = false;
        chkLock.checked = false;
        chkLock.disabled = true;
        chkAutoShadow.disabled = true;

        applyAutoShadow();

        for (const name of ['idle', 'atk', 'move']) {

            state.sequences[name] = unit.sequences[name] || [];

            const seq = state.sequences[name];

            while (seq.length > 1 && !(state.framesDBOrig[seq[seq.length - 1].id] || []).some(p => p && p.w > 0 && p.h > 0)) seq.pop();

            // spostamento fatto a mano con le frecce
            const nd = state.apngNudge[name];

            if (nd) for (const f of seq) { f.xOffset = nd.x; f.yOffset = nd.y; }
        }

        // nel menu solo le animazioni che l'unita' ha davvero (senza move non compare «Move»)
        fillAnimOptions([['idle', 'Idle'], ['atk', 'Attack'], ['move', 'Move']]
            .filter(([v]) => state.sequences[v] && state.sequences[v].length)
            .concat([['all', 'Completa (idle + move + attack)']]));

        if ([...selectAnim.options].some(o => o.value === state.current)) selectAnim.value = state.current;

        // «Completa» = il default: idle ripetuto come nel file, poi move e atk una volta
        if (split && (!opts.keep || opts.splitEdit)) {

            repeatInputs.idle.value = split.idleReps;
            repeatInputs.move.value = 1;
            repeatInputs.atk.value = 1;
        }

        rebuildAll();

        Eraser.attach(Renderer.image, state.framesDBOrig, state.framesDB);

        eraserRefresh();

        apngRenderSplit();

        apngRefresh();

        // numero dell'unita' come nome proposto per i file del sito
        if (state.unitId) {

            state.unitGuess = state.unitId;

            if (siteEls.name && !siteEls.name.dataset.edited) siteEls.name.value = state.unitId;
        }

        // misure diverse tra le animazioni: allineate in basso al centro
        const sizes = Object.entries(unit.sizes);

        if (new Set(sizes.map(([, z]) => z.w + 'x' + z.h)).size > 1) {

            notes.push('⚠ Le animazioni hanno misure diverse: le ho allineate in basso al centro. Se una è spostata, dimmelo.');
        }

        const label = { idle: 'Idle', atk: 'Attack', move: 'Move' };

        const lines = [
            `✔ Unità importata da APNG${state.unitId ? ' (' + state.unitId + ')' : ''}`,
            ...sizes.map(([k, z]) => {

                const ms = Math.round(sequenceTotalTicks(unit.sequences[k]) * TICK_MS);

                return `${label[k]}: ${z.frames} fotogramm${z.frames === 1 ? 'o' : 'i'} · ${z.w}×${z.h} · ${(ms / 1000).toFixed(2).replace('.', ',')} s${z.animated ? '' : ' (PNG fermo)'}`;
            }),
            ...(split ? (() => {

                const n = defDec.frames.length;

                const block = split.idleLen * split.idleReps;

                const atkLen = n - block - split.moveLen;

                return [
                    `📦 Default di ${n} fotogrammi tagliato in: Idle ${split.idleLen} (ripetuto ×${split.idleReps}) · Move ${split.moveLen || 'nessuno'} · Atk ${atkLen}${split.user ? ' — tagli scelti da te' : ''}`,
                    split.moveGuessed
                        ? '   Il move l\'ho indovinato dallo scatto in avanti: se non è giusto clicca, nell\'elenco qui sotto, il primo fotogramma dell\'attacco.'
                        : (!split.user && !split.moveLen)
                            ? '   Nessuno scatto in avanti: l\'unità non ha il move. Se invece ce l\'ha, clicca nell\'elenco qui sotto il primo fotogramma dell\'attacco.'
                            : ''
                ].filter(Boolean);
            })() : []),
            `${unit.cellCount} disegni diversi sul foglio`,
            ...(() => {

                const lib = sizes.some(([, z]) => apngIsLibrary(z.w, z.h)) && apngPos.preset;

                return [
                    apngPos.feet ? '📍 Piedi: posizione ricordata'
                        : lib ? '📍 Piedi: messi in automatico sulla croce gialla (fotogrammi 640×400)'
                            : '📍 Il personaggio non sta sulla croce gialla? «Segna i piedi» e clicca dove poggiano.',
                    (lib || apngPos.cuts.length)
                        ? `✂ Logo e scritta tolti${lib ? ' in automatico' : ''}${apngPos.cuts.length ? ` (+ ${apngPos.cuts.length} tuoi rettangoli)` : ''}`
                        : '✂ C\'è un logo o una scritta? «Togli il logo» e disegna un rettangolo sopra.'
                ];
            })(),
            ...notes
        ];

        multiInfo.innerText = lines.join('\n');

        apngSay(lines.slice(1).join('\n'));

        state.downloadCount = 1;

        if (resume) {

            // stessa animazione, stesso fotogramma, stessa pausa di prima
            if (state.sequences[resume.current] && state.sequences[resume.current].length) state.current = resume.current;

            selectAnim.value = state.current;

            beginPlayback();

            const len = (state.sequences[state.current] || []).length;

            state.frameIndex = Math.min(resume.frameIndex, Math.max(0, len - 1));
            state.isPaused = resume.paused;

            btnPause.innerText = resume.paused ? '▶ RIPRENDI' : '⏸ PAUSA';

            updateTimelineUI();
            renderCurrentFrame();

        } else {

            beginPlayback();
        }

    } catch (error) {

        console.error('Errore APNG:', error);

        apngSay(`⚠ Non riesco a importare: ${error.message}`);

        multiInfo.innerText = `⚠ APNG: ${error.message}`;
    }
}

apngEls.files.addEventListener('change', async (event) => {

    const list = [...event.target.files];

    event.target.value = '';

    if (!list.length) return;

    guessUnitName(list);

    await loadApngFiles(list);
});

// ---- DEFAULT: un solo APNG con tutto (idle ripetuto + move + atk), tagliato in tre
apngEls.defaultPick.addEventListener('change', async (event) => {

    const list = [...event.target.files];

    event.target.value = '';

    if (!list.length) return;

    guessUnitName(list);

    // il file scelto qui e' sempre un default, qualunque nome abbia; un nuovo default riparte dai tagli indovinati
    state.apngSplit = null;

    await loadApngFiles([list[0]], list.length > 1 ? ['ℹ Ho usato solo il primo file: il default è uno solo.'] : [], { defaultFile: list[0] });
});

const SPLIT_COLORS = { idle: '#3b82f6', move: '#22c55e', atk: '#ef4444' };

// elenco dei fotogrammi del default, colorati per animazione (blu idle, verde move, rosso atk)
function apngRenderSplit() {

    const dec = state.apngDefDec, split = state.apngSplit;

    apngEls.strip.replaceChildren();

    if (!dec || !split) return;

    const fr = dec.frames;

    // zona che contiene tutti i disegni (per le miniature)
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;

    for (const f of fr) {

        if (!f.data) continue;

        x0 = Math.min(x0, f.bx); y0 = Math.min(y0, f.by);
        x1 = Math.max(x1, f.bx + f.bw); y1 = Math.max(y1, f.by + f.bh);
    }

    if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }

    const TW = 58, TH = 50;

    const k = Math.min(TW / (x1 - x0), TH / (y1 - y0));

    const dw = Math.max(1, Math.round((x1 - x0) * k)), dh = Math.max(1, Math.round((y1 - y0) * k));

    const block = split.idleLen * split.idleReps;
    const moveEnd = block + split.moveLen;

    fr.forEach((f, i) => {

        const seg = i < block ? 'idle' : i < moveEnd ? 'move' : 'atk';

        const cell = document.createElement('div');

        cell.dataset.i = String(i);
        cell.title = `Fotogramma ${i + 1} · ${f.delay} ms · ${seg === 'idle' ? 'idle' : seg === 'move' ? 'move' : 'attacco'}\nClic = da qui inizia l'attacco`;
        cell.style.cssText = `position:relative;width:${TW}px;height:${TH + 12}px;border:2px solid ${SPLIT_COLORS[seg]};border-radius:4px;background:#1f2430;cursor:pointer;box-sizing:content-box;overflow:hidden;${seg === 'idle' && i >= split.idleLen ? 'opacity:.5' : ''}`;

        const cv = document.createElement('canvas');

        cv.width = TW;
        cv.height = TH;
        cv.style.cssText = 'display:block';

        if (f.data) {

            const tmp = document.createElement('canvas');

            tmp.width = f.bw;
            tmp.height = f.bh;

            tmp.getContext('2d').putImageData(new ImageData(f.data, f.bw, f.bh), 0, 0);

            const c2 = cv.getContext('2d');

            c2.imageSmoothingEnabled = false;

            c2.drawImage(tmp, Math.round((f.bx - x0) * k + (TW - dw) / 2), Math.round((f.by - y0) * k + (TH - dh) / 2), Math.max(1, Math.round(f.bw * k)), Math.max(1, Math.round(f.bh * k)));
        }

        const lab = document.createElement('div');

        lab.textContent = String(i + 1);
        lab.style.cssText = `font-size:10px;line-height:12px;text-align:center;color:#fff;background:${SPLIT_COLORS[seg]}`;

        cell.append(cv, lab);

        apngEls.strip.append(cell);
    });

    apngEls.splitIdle.value = split.idleLen;
    apngEls.splitReps.value = split.idleReps;
    apngEls.splitMove.value = split.moveLen;
    apngEls.splitIdle.max = apngEls.splitMove.max = apngEls.splitReps.max = fr.length;

    apngEls.splitInfo.textContent = `Idle ${split.idleLen} × ${split.idleReps} · Move ${split.moveLen || 'nessuno'} · Atk ${fr.length - block - split.moveLen}`;
}

// nuovi tagli: si rifa l'importazione con gli stessi file
async function apngApplySplit(next) {

    if (!state.apngDefDec) return;

    state.apngSplit = { ...clampSplit(next, state.apngDefDec.frames.length), user: true };

    await apngReimport([], { splitEdit: true });
}

apngEls.strip.addEventListener('click', (ev) => {

    const cell = ev.target.closest('[data-i]');

    if (!cell || !state.apngSplit) return;

    const i = Number(cell.dataset.i);

    const s = state.apngSplit;

    const block = s.idleLen * s.idleReps;

    if (i < block) {

        apngSay('ℹ Quei fotogrammi sono l\'idle (si cambiano con i numeri qui sotto). Per il move clicca il primo fotogramma dell\'ATTACCO.');

        return;
    }

    apngApplySplit({ ...s, moveLen: i - block });
});

for (const el of [apngEls.splitIdle, apngEls.splitReps, apngEls.splitMove]) {

    el.addEventListener('change', () => apngApplySplit({
        idleLen: apngEls.splitIdle.value,
        idleReps: apngEls.splitReps.value,
        moveLen: apngEls.splitMove.value
    }));
}

apngEls.fetch.addEventListener('click', async () => {

    const items = expandLinks(apngEls.links.value);

    apngSavePrefs();

    if (!items.length) {

        apngSay('Scrivi il numero dell\'unità (per esempio 10323) oppure incolla il link di un APNG.');

        return;
    }

    apngEls.fetch.disabled = true;

    apngSay(`Scarico ${items.length} file…`);

    try {

        let proxy = apngEls.proxy.value.trim();

        const pre = [];

        // la casella del servizio esterno e' facoltativa: se ci hanno messo un link di immagine la ignoro
        if (proxyLooksWrong(proxy)) {

            pre.push('ℹ Nella casella «servizio esterno» c\'era un link di immagine: l\'ho ignorata (quella casella va lasciata vuota).');

            proxy = '';
        }

        const { files, failed } = await fetchApngs(items, proxy);

        // il default che non esiste non e' un errore (non tutte le unita' ce l'hanno): se serve lo dice il resto
        const optionalMissing = (f) => items.some(i => i.optional && i.url === f.url);

        const notes = [...pre, ...failed.filter(f => !optionalMissing(f)).map(f => `⚠ ${f.url.split('/').pop()}: ${f.why}`)];

        if (!files.length) {

            const blocked = failed.some(f => f.blocked);

            apngSay([
                ...notes,
                blocked
                    ? 'Il sito non permette di scaricare i suoi file da questa pagina (è una protezione del sito, non un errore del programma). Soluzione sicura: apri il link nel browser, tasto destro → «Salva immagine con nome», poi trascina qui i file (oppure usa «Importa APNG dal PC»).'
                    : failed.some(f => f.unreachable)
                        ? 'Controlla il link e la connessione. Se il link si apre nel browser ma qui no, il sito blocca la richiesta: salva i file a mano e importali dal PC.'
                        : 'Controlla il numero o il link.'
            ].join('\n'));

            return;
        }

        await loadApngFiles(files, notes);

    } finally {

        apngEls.fetch.disabled = false;
    }
});

apngEls.proxy.addEventListener('change', apngSavePrefs);


// ---- "Salva come unita'": PNG + CGG + CGS veri (con le cancellazioni della gomma gia' applicate)

async function saveUnitFiles() {

    if (state.samMode || !Renderer.image || !state.framesDBOrig.length) {

        alert('Carica prima un\'unità (PNG + CGG + CGS oppure APNG).');

        return;
    }

    apngEls.save.disabled = true;

    try {

        const img = Renderer.image;

        const rows = state.framesDBOrig;

        // ritagli del foglio nuovo: quelli con pixel cancellati sono copie a parte
        const cells = new Map();

        const cellKey = (p, crop) => crop
            ? 'e|' + (p[EK] || '') + '|' + p.sx + ',' + p.sy + ',' + p.w + ',' + p.h
            : 'o|' + p.sx + ',' + p.sy + ',' + p.w + ',' + p.h;

        for (const row of rows) {

            for (const p of row || []) {

                if (!p || !(p.w > 0) || !(p.h > 0)) continue;

                const crop = Eraser.cropFor(img, p);

                const k = cellKey(p, crop);

                if (!cells.has(k)) cells.set(k, { w: p.w | 0, h: p.h | 0, crop, sx: p.sx, sy: p.sy, nx: 0, ny: 0 });
            }
        }

        const GAP = 1;

        let area = 0, widest = 0;

        for (const c of cells.values()) { area += (c.w + GAP) * (c.h + GAP); widest = Math.max(widest, c.w + GAP); }

        const width = Math.min(8192, Math.max(widest, 1024, Math.ceil(Math.sqrt(area) * 1.25)));

        let x = 0, y = 0, rowH = 0;

        for (const c of cells.values()) {

            if (x + c.w + GAP > width) { x = 0; y += rowH + GAP; rowH = 0; }

            c.nx = x;
            c.ny = y;

            x += c.w + GAP;

            rowH = Math.max(rowH, c.h);
        }

        const height = Math.max(1, y + rowH + GAP);

        const atlas = document.createElement('canvas');

        atlas.width = width;
        atlas.height = height;

        const actx = atlas.getContext('2d');

        for (const c of cells.values()) {

            if (c.crop) actx.drawImage(c.crop, c.nx, c.ny);
            else actx.drawImage(img, c.sx, c.sy, c.w, c.h, c.nx, c.ny, c.w, c.h);
        }

        const png = await new Promise(ok => atlas.toBlob(ok, 'image/png'));

        if (!png) throw new Error('non riesco a creare il PNG');

        // CGG: riga = id del frame; per pezzo: x,y,flip,blend,opacita',rotazione,sx,sy,w,h,pagina
        const cgg = rows.map((row, ri) => {

            const pieces = (row || []).filter(p => p);

            const parts = [ri, pieces.length];

            for (const p of pieces) {

                const c = (p.w > 0 && p.h > 0) ? cells.get(cellKey(p, Eraser.cropFor(img, p))) : null;

                parts.push(
                    Number(p.x) || 0, Number(p.y) || 0, Number(p.flipType) || 0, Number(p.blendMode) || 0,
                    Number.isFinite(p.opacity) ? p.opacity : 100, Number(p.rotate) || 0,
                    c ? c.nx : p.sx, c ? c.ny : p.sy, p.w, p.h, Number(p.pageId) || 0
                );
            }

            return parts.join(',');

        }).join('\n') + '\n';

        const id = state.unitId || siteFileBase().replace(/[^0-9A-Za-z_-]+/g, '') || 'unit';

        const enc = new TextEncoder();

        const zip = createZipWriter();

        zip.addFile('image.png', new Uint8Array(await png.arrayBuffer()));
        zip.addFile(`unit_cgg_${id}.csv`, enc.encode(cgg));

        const names = [];

        for (const name of ['idle', 'atk', 'move']) {

            const seq = state.sequences[name];

            if (!seq || !seq.length) continue;

            const text = seq.map(f => [f.id, Number(f.xOffset) || 0, Number(f.yOffset) || 0, Math.max(1, Math.round(Number(f.duration) || 1))].join(',')).join('\n') + '\n';

            zip.addFile(`unit_${name}_cgs_${id}.csv`, enc.encode(text));

            names.push(name);
        }

        await saveFile(zip.finish(), `${id}-unita.zip`, 'ZIP', 'application/zip', '.zip');

        apngSay(`💾 Salvato ${id}-unita.zip: image.png, unit_cgg_${id}.csv e i CGS di ${names.join(', ')}.\nDecomprimilo e, con «Carica TUTTI i file insieme», l'unità si apre come tutte le altre (con le cancellazioni della gomma già applicate).`);

    } catch (error) {

        console.error('Errore salvataggio unità:', error);

        apngSay(`⚠ Non riesco a salvare l'unità: ${error.message}`);

    } finally {

        apngRefresh();
    }
}

apngEls.save.addEventListener('click', saveUnitFiles);

// ------------------------------------------------------------
// POSIZIONE E LOGO
//
// "Segna i piedi": un clic sull'anteprima dove poggiano i piedi (centro dell'ombra). Quel punto diventa
// lo 0,0 (la croce gialla), come per le altre unita'. Si ricorda: le prossime unita' importate
// escono gia' a posto.
// "Togli il logo": si disegna un rettangolo sopra il logo / la scritta. Viene tolto da TUTTI i
// fotogrammi di tutte le animazioni (misurato dall'angolo in basso a sinistra del fotogramma) e si ricorda.
// ------------------------------------------------------------

// quale animazione sto guardando (con "Completa" quella del fotogramma mostrato)
function apngCurrentAnim() {

    if (['idle', 'atk', 'move'].includes(state.current)) return state.current;

    const entry = (state.sequences[state.current] || [])[state.frameIndex];

    return ['idle', 'atk', 'move'].find(n => (state.sequences[n] || []).includes(entry)) || null;
}

// punto del mondo (animatore) -> punto del fotogramma originale di quell'animazione
function apngToFrame(name, w) {

    const a = state.apngAnchors[name], nd = state.apngNudge[name] || { x: 0, y: 0 };

    return { x: w.x - nd.x + a.x, y: w.y - nd.y + a.y };
}

function apngArm(mode) {

    if (!state.imported) return;

    if (Eraser.on) eraserUI.toggle.click();

    if (!apngCurrentAnim()) { apngSay('Scegli prima Idle, Attack o Move nel menu «Azione Corrente».'); return; }

    apngPick.mode = apngPick.mode === mode ? null : mode;
    apngPick.drag = null;
    apngPick.pointer = null;

    // fermo l'animazione: si sceglie il punto su un fotogramma che non si muove
    if (apngPick.mode && state.isPlaying && !state.isPaused) {

        state.isPaused = true;

        btnPause.innerText = '▶ RIPRENDI';
    }

    apngEls.feet.style.background = apngPick.mode === 'feet' ? '#0f766e' : '';
    apngEls.cut.style.background = apngPick.mode === 'cut' ? '#be123c' : '';

    Renderer.canvas.style.cursor = apngPick.mode ? 'crosshair' : '';

    if (apngPick.mode === 'feet') apngSay('📍 Clicca sull\'anteprima dove poggiano i piedi (il centro dell\'ombra). Esc per annullare.\nConsiglio: ingrandisci con la rotella e usa un fotogramma fermo (pausa).');
    else if (apngPick.mode === 'cut') apngSay('✂ Trascina un rettangolo sopra il logo o la scritta. Verrà tolto da tutti i fotogrammi. Esc per annullare.');

    renderCurrentFrame();
}

function apngDisarm() {

    apngPick.mode = null;
    apngPick.drag = null;
    apngPick.pointer = null;

    apngEls.feet.style.background = '';
    apngEls.cut.style.background = '';

    Renderer.canvas.style.cursor = Eraser.on ? 'crosshair' : '';

    renderCurrentFrame();
}

function drawApngPick() {

    if (!apngPick.mode || !Renderer.ctx) return;

    const ctx = Renderer.ctx;
    const k = Renderer.scale * Renderer.dpr;

    ctx.save();

    ctx.translate(Renderer.canvas.width / 2 + Renderer.offsetX * Renderer.dpr, Renderer.canvas.height / 2 + Renderer.offsetY * Renderer.dpr);
    ctx.scale(k, k);

    ctx.lineWidth = 2 / k;

    if (apngPick.mode === 'feet' && apngPick.pointer) {

        const p = apngPick.pointer;

        ctx.strokeStyle = '#34d399';

        ctx.beginPath();
        ctx.moveTo(p.x - 14 / k, p.y); ctx.lineTo(p.x + 14 / k, p.y);
        ctx.moveTo(p.x, p.y - 14 / k); ctx.lineTo(p.x, p.y + 14 / k);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 / k, 0, Math.PI * 2);
        ctx.stroke();
    }

    if (apngPick.mode === 'cut' && apngPick.drag) {

        const d = apngPick.drag;

        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);

        ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
        ctx.fillRect(x, y, w, h);

        ctx.setLineDash([6 / k, 4 / k]);
        ctx.strokeStyle = '#ef4444';
        ctx.strokeRect(x, y, w, h);
    }

    ctx.restore();
}

async function apngReimport(notes = [], extra = {}) {

    if (!state.apngFiles.length) return;

    await loadApngFiles(state.apngFiles, notes, { keep: true, defaultFile: state.apngDefaultFile, ...extra });
}

Renderer.canvas.addEventListener('mousedown', (ev) => {

    if (!apngPick.mode || ev.button !== 0) return;

    ev.preventDefault();

    const w = eraserWorld(ev);

    if (apngPick.mode === 'cut') {

        apngPick.drag = { x0: w.x, y0: w.y, x1: w.x, y1: w.y };

        renderCurrentFrame();

        return;
    }

    // ---- piedi
    const name = apngCurrentAnim();

    if (!name || !state.apngAnchors[name]) return;

    const z = state.apngSizes[name];

    const c = apngToFrame(name, w);

    apngPos.feet = { dx: Math.round(c.x - z.w / 2), dy: Math.round(c.y - z.h) };

    apngSavePos();

    state.apngNudge = {};

    apngDisarm();

    apngReimport(['📍 Piedi segnati: ora il personaggio sta sulla croce gialla. Si ricorda per le prossime unità.']);
});

window.addEventListener('mousemove', (ev) => {

    if (!apngPick.mode) return;

    const over = ev.target === Renderer.canvas;

    if (!over && !apngPick.drag) { if (apngPick.pointer) { apngPick.pointer = null; renderCurrentFrame(); } return; }

    const w = eraserWorld(ev);

    apngPick.pointer = over ? w : null;

    if (apngPick.drag) { apngPick.drag.x1 = w.x; apngPick.drag.y1 = w.y; }

    if (!eraserRunning() || apngPick.drag) renderCurrentFrame();
});

window.addEventListener('mouseup', (ev) => {

    if (apngPick.mode !== 'cut' || !apngPick.drag) return;

    const d = apngPick.drag;

    apngPick.drag = null;

    const name = apngCurrentAnim();

    if (!name || !state.apngAnchors[name] || Math.abs(d.x1 - d.x0) < 2 || Math.abs(d.y1 - d.y0) < 2) { renderCurrentFrame(); return; }

    const z = state.apngSizes[name];

    const a = apngToFrame(name, { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1) });
    const b = apngToFrame(name, { x: Math.max(d.x0, d.x1), y: Math.max(d.y0, d.y1) });

    const left = Math.max(0, Math.floor(a.x)), right = Math.min(z.w, Math.ceil(b.x));
    const top = Math.max(0, Math.floor(a.y)), bottom = Math.min(z.h, Math.ceil(b.y));

    if (right - left < 1 || bottom - top < 1) { apngSay('⚠ Il rettangolo è fuori dal fotogramma: ridisegnalo sopra il logo.'); apngDisarm(); return; }

    apngPos.cuts.push({ l: left, b: z.h - bottom, w: right - left, h: bottom - top });

    apngPos.cuts = apngPos.cuts.slice(-12);

    apngSavePos();

    apngDisarm();

    apngReimport(['✂ Tolto il rettangolo da tutti i fotogrammi (si ricorda per le prossime unità). Le cancellazioni fatte prima con la gomma non si vedono più su questo foglio: meglio togliere il logo per primo.']);
});

window.addEventListener('keydown', (ev) => {

    if (ev.key === 'Escape' && apngPick.mode) { apngDisarm(); apngSay('Annullato.'); }
});

apngEls.feet.addEventListener('click', () => apngArm('feet'));
apngEls.cut.addEventListener('click', () => apngArm('cut'));

apngEls.reset.addEventListener('click', () => {

    apngPos.feet = null;
    apngPos.cuts = [];
    apngPos.preset = true;

    apngSavePos();

    state.apngNudge = {};

    apngDisarm();

    apngReimport(['↺ Posizione e logo tornati automatici (i tuoi piedi e rettangoli sono dimenticati).']);
});

// frecce: spostano tutta l'animazione che stai guardando (idle, atk o move)
for (const btn of apngEls.nudge) {

    btn.addEventListener('click', () => {

        const name = apngCurrentAnim();

        if (!name) { apngSay('Scegli prima Idle, Attack o Move nel menu «Azione Corrente».'); return; }

        const step = Number(apngEls.step.value) || 1;

        const [dx, dy] = btn.dataset.apngNudge.split(',').map(Number);

        const n = state.apngNudge[name] || (state.apngNudge[name] = { x: 0, y: 0 });

        n.x += dx * step;
        n.y += dy * step;

        for (const f of state.sequences[name] || []) { f.xOffset = n.x; f.yOffset = n.y; }

        apngSay(`↔ ${name}: spostata di ${n.x}, ${n.y} px (le altre animazioni non cambiano).`);

        updateExportInfo();
        renderCurrentFrame();
    });
}


apngRefresh();


// ============================================================
// RENDER FRAME CORRENTE
// ============================================================

/*
    Il passaggio morbido si vede solo mentre l'animazione gira.
    In pausa (o scorrendo a mano con le frecce / la timeline)
    si vede sempre il frame esatto del file.
*/

function renderCurrentFrame() {

    const sequence =
        state.sequences[state.current];


    if (
        !sequence ||
        sequence.length === 0
    ) {
        return;
    }


    const frameData =
        sequence[state.frameIndex];


    if (!frameData) {
        return;
    }


    // Durata frame

    state.currentFrameDuration =
        frameDuration(frameData);


    const running =
        state.isPlaying &&
        !state.isPaused;


    // quanto siamo avanzati dentro il frame (0..1)

    const t =
        running
            ? Math.min(
                1,
                (state.ticks + state.accum / state.tickMs) /
                state.currentFrameDuration
            )
            : 0;


    const pieces =
        composeFrame({
            sequence,
            framesDB: state.framesDB,
            shifts: activeShifts(),
            index: state.frameIndex,
            t,
            smooth: state.smooth && running
        });


    if (!pieces) {
        return;
    }


    // Zoom

    Renderer.scale =
        ZOOM_LEVEL;


    // Disegno (gli offset sono già dentro i pezzi)

    Renderer.draw(
        pieces,
        {
            xOffset: 0,
            yOffset: 0
        }
    );


    drawAreaOverlay();

    drawEraserCursor();

    drawApngPick();

    eraserSync();


    // Timeline

    timeline.value =
        state.frameIndex;


    // Contatore

    frameCounter.innerText =
        `${state.frameIndex + 1} / ${sequence.length}`;
}


// ============================================================
// AGGIORNA TIMELINE
// ============================================================

function updateTimelineUI() {

    const sequence =
        state.sequences[state.current];


    if (
        !sequence ||
        sequence.length === 0
    ) {
        return;
    }


    timeline.max =
        sequence.length - 1;


    timeline.value =
        state.frameIndex;


    frameCounter.innerText =
        `${state.frameIndex + 1} / ${sequence.length}`;
}


// ============================================================
// CAMBIO FRAME
// ============================================================

function advanceFrame(direction) {

    const sequence =
        state.sequences[state.current];


    if (
        !sequence ||
        sequence.length === 0
    ) {
        return;
    }


    state.frameIndex =
        (
            state.frameIndex +
            direction +
            sequence.length
        ) % sequence.length;


    state.ticks = 0;

    state.accum = 0;


    renderCurrentFrame();
}


// ============================================================
// PAUSA / RIPRENDI
// ============================================================

btnPause.onclick = () => {

    if (!state.isPlaying) {
        return;
    }


    state.isPaused =
        !state.isPaused;


    if (state.isPaused) {

        btnPause.innerText =
            "▶ RIPRENDI";

        // in pausa si vede il frame esatto

        renderCurrentFrame();

    } else {

        btnPause.innerText =
            "⏸ PAUSA";


        /*
            Evita uno scatto quando riprendiamo
            l'animazione.
        */

        state.lastTime =
            performance.now();

        state.accum = 0;
    }
};


// ============================================================
// FRAME SUCCESSIVO
// ============================================================

document
    .getElementById('nextFrame')
    .onclick = () => {

        state.isPaused = true;

        btnPause.innerText =
            "▶ RIPRENDI";

        advanceFrame(1);
    };


// ============================================================
// FRAME PRECEDENTE
// ============================================================

document
    .getElementById('prevFrame')
    .onclick = () => {

        state.isPaused = true;

        btnPause.innerText =
            "▶ RIPRENDI";

        advanceFrame(-1);
    };


// ============================================================
// TIMELINE
// ============================================================

timeline.addEventListener(
    'input',
    (event) => {

        state.isPaused = true;

        btnPause.innerText =
            "▶ RIPRENDI";


        state.frameIndex =
            parseInt(
                event.target.value,
                10
            );


        state.ticks = 0;

        state.accum = 0;


        renderCurrentFrame();
    }
);


// ============================================================
// CAMBIO ANIMAZIONE
// ============================================================

selectAnim.onchange =
    (event) => {

        state.current =
            event.target.value;

        updateSamDuration();


        state.frameIndex = 0;

        state.ticks = 0;

        state.accum = 0;


        if (state.isPlaying) {

            updateTimelineUI();

            renderCurrentFrame();
        }
    };


// ============================================================
// PARTENZA DELL'ANIMAZIONE (dopo aver caricato un'unita')
// ============================================================

function beginPlayback(firstOrder = ['idle', 'atk', 'move']) {

    // ====================================================
    // RESET ANIMAZIONE
    // ====================================================

    const firstAvailable =
        firstOrder
            .find(n => state.sequences[n] && state.sequences[n].length > 0);


    if (
        (!state.sequences[state.current] || state.sequences[state.current].length === 0) &&
        firstAvailable
    ) {

        state.current = firstAvailable;

        selectAnim.value = firstAvailable;
    }


    state.isPlaying = true;

    state.isPaused = false;

    state.frameIndex = 0;

    state.ticks = 0;

    state.accum = 0;

    state.lastTime =
        performance.now();


    // ====================================================
    // RESET DOWNLOAD
    // ====================================================

    state.downloadCount = 1;


    // ====================================================
    // RESET UI
    // ====================================================

    btnPause.innerText =
        "⏸ PAUSA";


    // ====================================================
    // PRIMO FRAME
    // ====================================================

    updateTimelineUI();

    renderCurrentFrame();


    // ====================================================
    // AVVIO GAME LOOP (una sola volta)
    // ====================================================

    if (!loopStarted) {

        loopStarted = true;

        requestAnimationFrame(
            gameLoop
        );
    }
}


// ============================================================
// VELOCITA' DEI .SAM
//
// Nel .sam ogni frame dura "dur" tick, ma il file non dice quanto
// dura un tick. Con 1/60 di secondo (come i CGS) le animazioni
// vengono lunghe il doppio di quelle del gioco, e con loro le GIF
// e i video (il doppio dei fotogrammi). Il valore di partenza e'
// 1/120 di secondo (8,3 ms) e si puo' cambiare: cursore sotto il
// menu delle animazioni. Vale per l'anteprima e per tutte le
// esportazioni.
// ============================================================

const SAM_TICK_KEY = 'animator.samTick';
const SAM_TICK_DEFAULT = 1000 / 120;

const samSpeedBox = document.getElementById('samSpeed');

const samEls = {
    range: document.getElementById('samTickRange'),
    num: document.getElementById('samTickMs'),
    info: document.getElementById('samDuration'),
    reduce: document.getElementById('samReduce'),
    reduceInfo: document.getElementById('samReduceInfo'),
    soft: document.getElementById('samSoft')
};

// passaggio tra i disegni di due frame, CGG e .sam (scelta salvata nel browser)
// (chiave nuova: una dissolvenza scelta per prova con le versioni vecchie non resta attiva senza che tu lo sappia)
const SAM_SOFT_KEY = 'animator.samSoft3';

try {

    const saved = localStorage.getItem(SAM_SOFT_KEY);

    if (saved !== null && [...samEls.soft.options].some(o => o.value === saved)) samEls.soft.value = saved;

} catch (e) { /* ignoro */ }

setSamSoft(samEls.soft.value);

// avviso vicino ai pulsanti di esportazione: con una dissolvenza attiva GIF, APNG e video
// mostrano doppie immagini tra una posa e l'altra
function refreshSoftWarn() {

    const el = document.getElementById('samSoftWarn');

    if (!el) return;

    const on = Number(samEls.soft.value) > 0;

    el.style.display = on ? 'block' : 'none';

    if (on) {

        el.textContent = '⚠ «Passaggio tra i disegni» è su «' + samEls.soft.selectedOptions[0].text.replace(/\s*\(.*\)\s*$/, '')
            + '»: quando un pezzo cambia disegno le immagini si mescolano e si vedono pezzi semitrasparenti e doppi (effetto fantasma) in GIF, APNG e video. '
            + 'Per i frame esatti del file scegli «Netto».';
    }
}

samEls.soft.addEventListener('change', () => {

    setSamSoft(samEls.soft.value);

    refreshSoftWarn();

    try { localStorage.setItem(SAM_SOFT_KEY, samEls.soft.value); } catch (e) { /* ignoro */ }

    renderCurrentFrame();
});

const SAM_REDUCE_KEY = 'animator.samReduce';

const round1 = (v) => Math.round(v * 10) / 10;

function readSamTick() {

    try {

        const v = Number(localStorage.getItem(SAM_TICK_KEY));

        if (v >= 2 && v <= 80) return v;

    } catch (e) { /* ignoro */ }

    return SAM_TICK_DEFAULT;
}

// "Durata: 7,4 s" dell'animazione scelta con la velocita' di adesso
function updateSamDuration() {

    if (!state.samMode) return;

    const seq = state.sequences[state.current] || [];

    const ticks = sequenceTotalTicks(seq);

    samEls.info.textContent =
        `${seq.length} frame · durata ${(ticks * state.tickMs / 1000).toFixed(2).replace('.', ',')} s`;
}

function setSamTick(ms) {

    const v = Math.min(80, Math.max(2, Number(ms) || SAM_TICK_DEFAULT));

    state.tickMs = v;

    samEls.num.value = round1(v);
    samEls.range.value = v;

    try { localStorage.setItem(SAM_TICK_KEY, String(v)); } catch (e) { /* ignoro */ }

    updateSamDuration();
}

samEls.range.addEventListener('input', () => setSamTick(samEls.range.value));
samEls.num.addEventListener('change', () => setSamTick(samEls.num.value));

document.getElementById('samTickReset').addEventListener('click', () => setSamTick(SAM_TICK_DEFAULT));

// ============================================================
// MODO CGG / MODO .SAM
//
// Con i file CGG / CGS le animazioni sono sempre idle, atk, move. Con un
// .sam sono quelle che ci sono nel file (Idle, Move, Attack, Dead...): il
// menu si riempie di conseguenza.
// ============================================================

function fillAnimOptions(list) {

    selectAnim.innerHTML = '';

    for (const [value, label] of list) selectAnim.add(new Option(label, value));
}

function setStandardMode() {

    state.samMode = false;

    state.imported = false;
    state.unitId = '';

    state.animNames = ['idle', 'move', 'atk'];

    state.sequences = { idle: [], atk: [], move: [], all: [] };

    if (!['idle', 'atk', 'move', 'all'].includes(state.current)) state.current = 'idle';

    fillAnimOptions([
        ['idle', 'Idle'],
        ['atk', 'Attack'],
        ['move', 'Move'],
        ['all', 'Completa (idle + move + attack)']
    ]);

    selectAnim.value = state.current;

    state.samShadowKeys = null;

    chkAutoShadow.disabled = false;
    chkLock.disabled = false;

    applyLockPref();

    // i CGS contano sempre 1/60 di secondo per tick
    state.tickMs = TICK_MS;
    samSpeedBox.style.display = 'none';

    refreshSoftWarn();
}

function setSamMode(unit) {

    state.samMode = true;

    state.imported = false;
    state.unitId = '';

    state.animNames = unit.order;

    state.samFull = unit.sequences;
    state.samLabels = unit.labels;

    // frame principali (scelta salvata nel browser)
    try {

        const saved = localStorage.getItem(SAM_REDUCE_KEY);

        if (saved !== null && [...samEls.reduce.options].some(o => o.value === saved)) samEls.reduce.value = saved;

    } catch (e) { /* ignoro */ }

    // ombra del .sam (il pezzo piatto sotto a tutto): serve a "Blocca a terra" e a
    // "Ombra a terra se manca", che funzionano come per il CGG. Le caselle restano
    // come le hai messe tu: il caricamento di un file non le cambia.
    state.samShadowKeys = findShadowKeys(unit.framesDB);

    chkAutoShadow.disabled = false;
    chkLock.disabled = false;

    applyLockPref();

    applyAutoShadow();

    applySamReduce();

    // velocita' scelta per i .sam (salvata nel browser)
    state.tickMs = readSamTick();
    samEls.num.value = round1(state.tickMs);
    samEls.range.value = state.tickMs;
    samSpeedBox.style.display = 'flex';
    updateSamDuration();

    if (state.current !== 'all' && !state.sequences[state.current]) state.current = unit.order[0];

    selectAnim.value = state.current;

    updateSamDuration();

    refreshSoftWarn();
}

// tiene solo i frame principali di ogni animazione (o tutti, se la tolleranza e' 0) e riempie il menu
function applySamReduce() {

    const tol = Number(samEls.reduce.value) || 0;

    const seqs = {};
    const parts = [];

    for (const k of state.animNames) {

        const full = state.samFull[k] || [];

        seqs[k] = tol ? reduceSamSequence(full, state.framesDB, tol) : full;

        parts.push(`${state.samLabels[k]} ${full.length}${tol ? ' → ' + seqs[k].length : ''}`);
    }

    state.sequences = { ...seqs, all: [] };

    rebuildAll();

    fillAnimOptions([
        ...state.animNames.map(k => [
            k,
            `${state.samLabels[k]} (${tol ? state.samFull[k].length + ' → ' : ''}${seqs[k].length} frame)`
        ]),
        ['all', 'Completa (tutte le animazioni)']
    ]);

    selectAnim.value = state.sequences[state.current] ? state.current : state.animNames[0];

    state.current = selectAnim.value;

    refreshSamInfo();

    updateSamDuration();
}

// riga sotto "Frame da usare". Non cambia nessuna casella: se il Morbido e' spento lo dice soltanto
function refreshSamInfo() {

    if (!state.samMode) return;

    const tol = Number(samEls.reduce.value) || 0;

    const parts = state.animNames.map(k =>
        `${state.samLabels[k]} ${state.samFull[k].length}${tol ? ' → ' + state.sequences[k].length : ''}`
    );

    const noSmooth = tol && (!state.smooth || !document.getElementById('exportSmooth').checked);

    samEls.reduceInfo.textContent =
        (tol ? 'Frame: ' + parts.join(' · ') : 'Tutti i frame del file (' + parts.join(' · ') + ')') +
        (noSmooth ? '\n⚠ Morbido spento: con i frame principali può sembrare a scatti' : '');
}

samEls.reduce.addEventListener('change', () => {

    try { localStorage.setItem(SAM_REDUCE_KEY, samEls.reduce.value); } catch (e) { /* ignoro */ }

    applySamReduce();

    saveExportPrefs();

    // si riparte dall'inizio: i frame sono cambiati
    state.frameIndex = 0;
    state.ticks = 0;
    state.accum = 0;

    updateTimelineUI();
    renderCurrentFrame();
});


// ============================================================
// START
// ============================================================

btnStart.onclick = async () => {

    const files = {

        img:
            document
                .getElementById('img')
                .files[0],

        cgg:
            document
                .getElementById('cgg')
                .files[0],

        idle:
            document
                .getElementById('idle')
                .files[0],

        atk:
            document
                .getElementById('atk')
                .files[0],

        move:
            document
                .getElementById('move')
                .files[0]
    };


    // ========================================================
    // CONTROLLO FILE
    // ========================================================

    if (!files.img || !files.cgg) {

        alert(
            "Carica almeno PNG e CGG!"
        );

        return;
    }


    try {

        // ====================================================
        // CARICAMENTO PNG
        // ====================================================

        await Renderer.loadImage(
            files.img
        );


        // si torna al modo CGG (se prima c'era un'unita' .sam)
        setStandardMode();


        // ====================================================
        // PARSING CGG
        // ====================================================

        state.framesDBOrig =
            Parser.parseCGG(
                await files.cgg.text()
            );

        state.framesDB = state.framesDBOrig;


        // punto d'appoggio di ogni frame (ombra): si calcola sul CGG
        // originale, l'ombra aggiunta dopo sta ferma dov'e'

        state.shifts =
            computeGroundShifts(
                state.framesDBOrig
            );

        applyAutoShadow();


        // ====================================================
        // PARSING IDLE / ATK / MOVE
        // ====================================================

        for (const name of ['idle', 'atk', 'move']) {

            state.sequences[name] =
                files[name]
                    ? Parser.parseCGS(
                        await files[name].text()
                    )
                    : [];

            // il frame finale non deve mai essere vuoto (riga del CGG senza pezzi)
            const seq = state.sequences[name];

            while (
                seq.length > 1 &&
                !(state.framesDBOrig[seq[seq.length - 1].id] || []).some(p => p && p.w > 0 && p.h > 0)
            ) {
                seq.pop();
            }
        }


        rebuildAll();

        // la gomma ritrova le cancellazioni gia' fatte su questa unita'
        Eraser.attach(Renderer.image, state.framesDBOrig, state.framesDB);

        eraserRefresh();

        apngRefresh();

        beginPlayback();

    } catch (error) {

        console.error(
            "Errore:",
            error
        );


        alert(
            "Errore nel caricamento dei file."
        );
    }
};


// ============================================================
// DOWNLOAD FRAME
// ============================================================

btnImage.onclick = async () => {

    const sequence =
        state.sequences[state.current];


    if (
        !state.isPlaying ||
        !sequence ||
        sequence.length === 0
    ) {

        alert(
            "Avvia l'animazione prima di scaricare il frame!"
        );

        return;
    }


    // ========================================================
    // CONTROLLO SUPPORTO BROWSER
    // ========================================================

    if (!window.showSaveFilePicker) {

        alert(
            "Il tuo browser non supporta questa funzione. Usa Chrome o Edge."
        );

        return;
    }


    try {

        // ====================================================
        // CREAZIONE PNG
        // ====================================================

        /*
            Si salva sempre il frame ESATTO (senza passaggio
            morbido), anche se in quel momento l'animazione gira.
        */

        // senza rettangolo e croce dell'area: sono solo una guida a schermo
        state.hideOverlay = true;

        renderCurrentFrame();

        let blob;

        try {

            blob = await new Promise(
                resolve => {

                    Renderer.canvas.toBlob(
                        resolve,
                        'image/png'
                    );
                }
            );

        } finally {

            state.hideOverlay = false;

            renderCurrentFrame();
        }


        if (!blob) {

            throw new Error(
                "Impossibile creare il PNG."
            );
        }


        // ====================================================
        // NOME FILE
        // ====================================================

        const suggestedFileName =
            `download${state.downloadCount}.png`;


        // ====================================================
        // SAVE FILE PICKER
        // ====================================================

        const handle =
            await window.showSaveFilePicker({

                suggestedName:
                    suggestedFileName,

                types: [

                    {
                        description:
                            'Immagine PNG',

                        accept: {
                            'image/png':
                                ['.png']
                        }
                    }
                ]
            });


        // ====================================================
        // SCRITTURA
        // ====================================================

        const writable =
            await handle.createWritable();


        await writable.write(blob);

        await writable.close();


        // ====================================================
        // INCREMENTO
        // ====================================================

        state.downloadCount++;

    } catch (error) {

        if (
            error.name ===
            'AbortError'
        ) {
            return;
        }


        console.error(
            "Errore:",
            error
        );


        alert(
            "Errore durante il salvataggio."
        );
    }
};


// ============================================================
// ESPORTAZIONE (GIF / APNG / sequenza PNG)
//
// Ogni fotogramma e' ricavato dal tempo reale del CGS (non dai
// singoli frame): con 50 fps ogni passaggio viene campionato piu'
// volte e, con "Morbido" acceso, i pezzi si muovono in modo
// continuo. L'area e' la stessa per tutti i fotogrammi.
// ============================================================

const pause0 = () => new Promise(resolve => setTimeout(resolve, 0));




/*
    Ingrandimento dell'esportazione: un numero fisso (2x, 4x...) oppure
    "come lo zoom dello schermo": il personaggio esce grande esattamente
    come lo vedi nell'area di lavoro, e l'area (fissa / allargata) gli
    da' lo spazio in piu' attorno.
*/

/*
    MODELLO COMUNE: zoom + posizione + area scelti una volta sola.
    Tutte le unita' esportate con il modello escono con la STESSA
    dimensione in pixel, il personaggio grande uguale e nello stesso
    punto: nel tuo progetto basta un solo CSS per tutti.
*/

const TEMPLATE_KEY = 'animator.template';

let template = null;

try {

    template = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || 'null');

} catch (e) { template = null; }

function exportScale() {

    const v = document.getElementById('gifScale').value;

    if (v === 'view') return Math.max(0.05, Renderer.scale);

    // stessa inquadratura e stessi valori CSS, ma meta' dei pixel per lato (file 4 volte piu' leggero)
    if (v === 'view-half') return Math.max(0.05, Renderer.scale / 2);

    if (v === 'locked' && template) return template.k;

    return Number(v) || 2;
}


// ------------------------------------------------------------
// AREA FISSA: larghezza, altezza e posizione dei piedi si
// cambiano con i campi nel pannello e si vedono subito sullo
// schermo come un rettangolo tratteggiato. Restano salvate.
// ------------------------------------------------------------

const AREA_KEY = 'animator.area';

const areaEls = {
    fixed: document.getElementById('areaFixed'),
    screen: document.getElementById('areaScreen'),
    extra: document.getElementById('areaExtra'),
    crop: document.getElementById('areaCrop'),
    w: document.getElementById('areaW'),
    h: document.getElementById('areaH'),
    feet: document.getElementById('areaFeet'),
    ax: document.getElementById('areaX')
};

try {

    const v = JSON.parse(localStorage.getItem(AREA_KEY) || 'null');

    if (v) {

        areaEls.fixed.checked = !!v.fixed;
        areaEls.screen.checked = !!v.screen;
        if (v.extra !== undefined) areaEls.extra.checked = !!v.extra;
        if (v.crop !== undefined) areaEls.crop.checked = !!v.crop;
        if (v.w) areaEls.w.value = v.w;
        if (v.h) areaEls.h.value = v.h;
        if (v.feet) areaEls.feet.value = v.feet;
        if (v.ax) areaEls.ax.value = v.ax;
    }

} catch (e) { /* ignoro */ }

function anchorPct() {

    const clamp = (v, d) => Math.max(5, Math.min(95, Number(v) || d));

    return { ax: clamp(areaEls.ax.value, 50), ay: clamp(areaEls.feet.value, 80) };
}

function fixedBox() {

    const W = Math.max(16, parseInt(areaEls.w.value, 10) || 300);
    const H = Math.max(16, parseInt(areaEls.h.value, 10) || 300);

    const { ax, ay } = anchorPct();

    const w = W + (W % 2);
    const h = H + (H % 2);

    // il punto di appoggio (i piedi) sta a ax% / ay% dell'area
    return { x: -Math.round(w * ax / 100), y: -Math.round(h * ay / 100), w, h };
}

Object.values(areaEls).forEach(el => el.addEventListener('input', () => {

    try {

        localStorage.setItem(AREA_KEY, JSON.stringify({
            fixed: areaEls.fixed.checked,
            screen: areaEls.screen.checked,
            extra: areaEls.extra.checked,
            crop: areaEls.crop.checked,
            w: areaEls.w.value,
            h: areaEls.h.value,
            feet: areaEls.feet.value,
            ax: areaEls.ax.value
        }));

    } catch (e) { /* ignoro */ }

    updateExportInfo();

    renderCurrentFrame();
}));

// rettangolo tratteggiato dell'area di esportazione (solo a schermo)
function drawAreaOverlay() {

    if (!areaEls.fixed.checked || areaEls.screen.checked || !Renderer.ctx || state.hideOverlay) return;

    const box = fixedBox();
    const ctx = Renderer.ctx;
    const k = Renderer.scale * Renderer.dpr;

    ctx.save();

    ctx.translate(
        Renderer.canvas.width / 2 + Renderer.offsetX * Renderer.dpr,
        Renderer.canvas.height / 2 + Renderer.offsetY * Renderer.dpr
    );

    ctx.scale(k, k);

    ctx.lineWidth = 2 / k;
    ctx.setLineDash([8 / k, 6 / k]);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';
    ctx.strokeRect(box.x, box.y, box.w, box.h);

    // croce nel punto dei piedi (origine del personaggio)
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(-6 / k, 0); ctx.lineTo(6 / k, 0);
    ctx.moveTo(0, -6 / k); ctx.lineTo(0, 6 / k);
    ctx.stroke();

    ctx.restore();
}



// ------------------------------------------------------------
// "ALLARGA AREA": ogni unita' ha un raggio d'azione diverso.
// Il pulsante allarga l'area fissa (mai la restringe) quanto serve
// per contenere TUTTE le animazioni dell'unita' caricata, tenendo i
// piedi nello stesso punto. Si ripete per ogni unita': alla fine
// l'area contiene tutte e i video escono con la stessa dimensione e
// il personaggio sempre nella stessa posizione, senza tagli.
// ------------------------------------------------------------

document.getElementById('growArea').onclick = () => {

    if (!state.isPlaying) {

        alert("Avvia l'animazione prima di allargare l'area!");

        return;
    }

    const shifts = activeShifts();

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

    for (const name of state.animNames) {

        const seq = state.sequences[name];

        if (!seq || !seq.length) continue;

        const b = sequenceBounds(seq, state.framesDB, shifts);

        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
    }

    if (!(x0 <= x1)) return;

    const MARGIN = 6;

    const cur = fixedBox();

    const { ax, ay } = anchorPct();

    // spazio che serve a sinistra / destra / sopra / sotto i piedi
    const L = Math.ceil(-x0) + MARGIN;
    const R = Math.ceil(x1) + MARGIN;
    const U = Math.ceil(-y0) + MARGIN;
    const D = Math.ceil(y1) + MARGIN;

    // l'area cresce finche' la posizione dei piedi (ax, ay) resta quella
    // scelta e tutto ci sta dentro; non si restringe mai
    const need = (a, b, frac) => Math.max(a / (frac / 100), b / (1 - frac / 100));

    const W = Math.ceil(Math.max(cur.w, need(L, R, ax)) / 10) * 10;
    const H = Math.ceil(Math.max(cur.h, need(U, D, ay)) / 10) * 10;

    areaEls.w.value = W;
    areaEls.h.value = H;

    areaEls.fixed.checked = true;
    areaEls.screen.checked = false;

    // salva e ridisegna
    areaEls.w.dispatchEvent(new Event('input'));
};


document.getElementById('lockTemplate').onclick = () => {

    if (!state.isPlaying) {

        alert("Avvia l'animazione prima!");

        return;
    }

    const cssW = Renderer.canvas.width / Renderer.dpr;
    const cssH = Renderer.canvas.height / Renderer.dpr;

    const k = Renderer.scale;

    // dove sono i piedi nel riquadro che vedi (px) e quanto e' grande il riquadro
    const ox = cssW / 2 + Renderer.offsetX;
    const oy = cssH / 2 + Renderer.offsetY;

    // spazio extra attorno al riquadro, in % della sua dimensione
    const E = Math.max(0, Number(document.getElementById('tplExtra').value) || 0) / 100;

    const wx0 = -ox / k, wy0 = -oy / k;     // angolo del riquadro (mondo)
    const ww = cssW / k, wh = cssH / k;

    let bx = wx0 - ww * E, by = wy0 - wh * E;
    let bw = ww * (1 + 2 * E), bh = wh * (1 + 2 * E);

    bw = Math.ceil(bw); bh = Math.ceil(bh);
    bw += bw % 2; bh += bh % 2;

    areaEls.w.value = bw;
    areaEls.h.value = bh;
    areaEls.ax.value = Math.max(5, Math.min(95, -bx / bw * 100)).toFixed(3);
    areaEls.feet.value = Math.max(5, Math.min(95, -by / bh * 100)).toFixed(3);

    areaEls.fixed.checked = true;
    areaEls.screen.checked = false;

    template = { k, cssW, cssH, ox, oy };

    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(template)); } catch (e) { /* ignoro */ }

    document.getElementById('gifScale').value = 'locked';
    document.getElementById('gifScale').dispatchEvent(new Event('change'));

    areaEls.w.dispatchEvent(new Event('input'));
};

// prende ax / ay da dove hai messo il personaggio nell'area di lavoro
document.getElementById('copyCss').onclick = async () => {

    const text = document.getElementById('cssText').innerText;

    try {

        await navigator.clipboard.writeText(text);

        document.getElementById('copyCss').innerText = '✔ Copiato';

        setTimeout(() => { document.getElementById('copyCss').innerText = '📋 Copia'; }, 1500);

    } catch (e) {

        alert(text);
    }
};

document.getElementById('anchorFromScreen').onclick = () => {

    const cssW = Renderer.canvas.width / Renderer.dpr;
    const cssH = Renderer.canvas.height / Renderer.dpr;

    const px = (cssW / 2 + Renderer.offsetX) / cssW * 100;
    const py = (cssH / 2 + Renderer.offsetY) / cssH * 100;

    areaEls.ax.value = Math.max(5, Math.min(95, px)).toFixed(1);
    areaEls.feet.value = Math.max(5, Math.min(95, py)).toFixed(1);

    areaEls.fixed.checked = true;
    areaEls.screen.checked = false;

    areaEls.ax.dispatchEvent(new Event('input'));
};

/*
    "Come lo schermo": esporta esattamente quello che vedi nel riquadro
    scuro, con lo zoom e la posizione di adesso (e cambia solo la
    risoluzione, secondo "Esporta: ingrandimento").
*/

function screenBox() {

    const cssW = Renderer.canvas.width / Renderer.dpr;
    const cssH = Renderer.canvas.height / Renderer.dpr;

    const k = Renderer.scale;

    // il riquadro che vedi, in coordinate del personaggio
    const vx0 = -(cssW / 2 + Renderer.offsetX) / k;
    const vy0 = -(cssH / 2 + Renderer.offsetY) / k;
    const vw = cssW / k;
    const vh = cssH / k;

    let halfW = vw / 2;
    let halfH = vh / 2;

    const cx = vx0 + halfW;
    const cy = vy0 + halfH;

    /*
        Spazio extra: se qualche frame di qualche animazione esce dal
        riquadro, l'area cresce in modo uguale a destra e a sinistra (e
        sopra e sotto) attorno al centro del riquadro: il personaggio
        resta dove l'hai messo, senza spostarsi da un lato.
    */

    if (areaEls.extra.checked) {

        const shifts = activeShifts();

        for (const name of state.animNames) {

            const seq = state.sequences[name];

            if (!seq || !seq.length) continue;

            const b = sequenceBounds(seq, state.framesDB, shifts);

            halfW = Math.max(halfW, Math.abs(b.x - cx), Math.abs(b.x + b.w - cx));
            halfH = Math.max(halfH, Math.abs(b.y - cy), Math.abs(b.y + b.h - cy));
        }
    }

    let w = Math.ceil(halfW * 2) + 1;
    let h = Math.ceil(halfH * 2) + 1;

    w += w % 2;
    h += h % 2;

    let box = { x: Math.floor(cx - w / 2), y: Math.floor(cy - h / 2), w, h };

    /*
        Ritaglia intorno al personaggio: lo stesso schermo, ma senza i
        margini vuoti (un file grande quanto tutto lo schermo, con il
        personaggio alto 120 pixel, e' lento da riprodurre). I pixel
        restano quelli di prima; cambiano solo le dimensioni del file e
        la posizione, che il box "CSS del video" aggiorna da solo.
    */

    if (areaEls.crop.checked) {

        const shifts = activeShifts();

        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

        for (const name of state.animNames) {

            const seq = state.sequences[name];

            if (!seq || !seq.length) continue;

            const b = sequenceBounds(seq, state.framesDB, shifts);

            x0 = Math.min(x0, b.x);
            y0 = Math.min(y0, b.y);
            x1 = Math.max(x1, b.x + b.w);
            y1 = Math.max(y1, b.y + b.h);
        }

        // solo la parte che si vedrebbe comunque nell'esportazione intera
        x0 = Math.max(x0, box.x);
        y0 = Math.max(y0, box.y);
        x1 = Math.min(x1, box.x + box.w);
        y1 = Math.min(y1, box.y + box.h);

        if (x1 > x0 && y1 > y0) {

            /*
                Si ritaglia sulla griglia dei PIXEL DI USCITA dell'esportazione
                intera: cosi' ogni pixel del ritaglio e' identico a quello del
                file grande (nessuno slittamento di mezzo pixel).
            */

            const kk = exportScale();

            const ix0 = Math.floor((x0 - box.x) * kk);
            const iy0 = Math.floor((y0 - box.y) * kk);

            let iw = Math.ceil((x1 - box.x) * kk) - ix0;
            let ih = Math.ceil((y1 - box.y) * kk) - iy0;

            // misure pari: i video non amano i pixel dispari
            iw += iw % 2;
            ih += ih % 2;

            box = { x: box.x + ix0 / kk, y: box.y + iy0 / kk, w: iw / kk, h: ih / kk };
        }
    }

    return {
        ...box,
        view: { x: vx0, y: vy0, w: vw, h: vh }
    };
}

function updateExportInfo() {

    const el = document.getElementById('areaInfo');

    if (!el) return;

    const scale = exportScale();

    let box = null;

    if (areaEls.screen.checked) box = screenBox();
    else if (areaEls.fixed.checked) box = fixedBox();

    const cssEl = document.getElementById('cssBox');

    if (cssEl) cssEl.style.display = 'none';

    if (!box) {

        el.innerText = 'Area: automatica (tutta l\'animazione)';

        return;
    }

    const W = Math.round(box.w * scale);
    const H = Math.round(box.h * scale);

    const eff = limitScale(box, scale, gifMaxMp());

    el.innerText = `Uscita: ${W}×${H} px`
        + (Math.max(W, H) > 4096 ? ' (troppo grande!)' : '')
        + (eff < scale
            ? ` · la GIF esce ridotta a ${Math.max(1, Math.round(box.w * eff))}×${Math.max(1, Math.round(box.h * eff))} px, per restare fluida`
            : (W * H > 2_000_000 && Math.max(W, H) <= 4096
                ? ' ⚠ molto grande: la GIF / il video possono andare a scatti. Spunta «Ritaglia intorno al personaggio», scegli «Metà dello schermo» o attiva il limite dei megapixel.'
                : ''));

    /*
        Valori CSS per metterlo nel tuo progetto: il contenitore ha le
        proporzioni dell'area di lavoro (position: relative; overflow:
        hidden) e il video e' position: absolute con questi valori.
        Cosi' il personaggio e' grande come qui e non devi cercare i
        numeri a mano.
    */

    let cssParams = null;

    if (areaEls.screen.checked && box.view) {

        const k = Renderer.scale;

        cssParams = {
            k,
            cssW: box.view.w * k,
            cssH: box.view.h * k,
            ox: -box.view.x * k,
            oy: -box.view.y * k
        };

    } else if (areaEls.fixed.checked && template && document.getElementById('gifScale').value === 'locked') {

        cssParams = { k: template.k, cssW: template.cssW, cssH: template.cssH, ox: template.ox, oy: template.oy };
    }

    if (cssEl && cssParams) {

        const { k, cssW, cssH, ox, oy } = cssParams;

        const pct = (n) => (Math.round(n * 100) / 100) + '%';

        // posizione dei piedi dentro il video, in pixel di uscita
        const originX = -box.x * k;
        const originY = -box.y * k;

        const css =
            `width: ${pct(box.w * k / cssW * 100)};\n` +
            `height: ${pct(box.h * k / cssH * 100)};\n` +
            `left: ${pct(-(originX - ox) / cssW * 100)};\n` +
            `top: ${pct(-(originY - oy) / cssH * 100)};`;

        document.getElementById('cssText').innerText = css;

        cssEl.style.display = 'block';
    }
}

// ingrandimento, fps e sfondo dell'esportazione restano come li hai scelti
const EXPORT_KEY = 'animator.export';

const bgEls = {
    color: document.getElementById('gifBg'),
    range: document.getElementById('bgAlpha'),
    num: document.getElementById('bgAlphaNum'),
    all: document.getElementById('bgAll'),
    fill: document.getElementById('bgPreviewFill')
};

// anteprima a scacchiera: colore + opacita' scelti
function refreshBgPreview() {

    const o = backgroundOptions();

    bgEls.fill.style.background = o.bgFill || 'transparent';
}

try {

    const v = JSON.parse(localStorage.getItem(EXPORT_KEY) || 'null');

    if (v && v.scale) document.getElementById('gifScale').value = v.scale;
    if (v && v.fps) document.getElementById('gifFps').value = v.fps;

    if (v && v.smooth === false) document.getElementById('exportSmooth').checked = false;

    // le caselle dello schermo restano come le hai lasciate (anche cambiando file)
    if (v && v.screenSmooth === false) { chkSmooth.checked = false; state.smooth = false; }

    if (v && v.lock === false) lockPref.cgg = false;
    if (v && v.lockSam === true) lockPref.sam = true;

    applyLockPref();

    if (v && v.autoShadow === false) chkAutoShadow.checked = false;

    if (v && v.gifLimit === false) document.getElementById('gifLimit').checked = false;
    if (v && Number(v.gifLimitMp) > 0) document.getElementById('gifLimitMp').value = v.gifLimitMp;

    if (v && /^#[0-9a-f]{6}$/i.test(v.bg || '')) bgEls.color.value = v.bg;

    if (v && Number.isFinite(Number(v.bgAlpha)) && v.bgAlpha !== null && v.bgAlpha !== '') {

        const a = Math.min(100, Math.max(0, Number(v.bgAlpha)));

        bgEls.range.value = a;
        bgEls.num.value = a;
    }

    if (v && v.bgAll) bgEls.all.checked = true;

    // la scelta salvata vale solo se fatta con questa versione (gifSoftV 2): le
    // vecchie versioni mettevano i puntini su tutto, e la scelta restava
    // salvata nel browser anche dopo l'aggiornamento
    if (v && v.gifSoftV === 2 && (v.gifSoft === 'all' || v.gifSoft === 'off' || v.gifSoft === 'shadow')) document.getElementById('gifSoft').value = v.gifSoft;

} catch (e) { /* ignoro */ }

function saveExportPrefs() {

    try {

        localStorage.setItem(EXPORT_KEY, JSON.stringify({
            scale: document.getElementById('gifScale').value,
            fps: document.getElementById('gifFps').value,
            smooth: document.getElementById('exportSmooth').checked,
            gifLimit: document.getElementById('gifLimit').checked,
            gifLimitMp: document.getElementById('gifLimitMp').value,
            bg: bgEls.color.value,
            bgAlpha: bgEls.num.value,
            bgAll: bgEls.all.checked,
            gifSoft: document.getElementById('gifSoft').value,
            gifSoftV: 2,
            autoShadow: chkAutoShadow.checked,
            screenSmooth: chkSmooth.checked,
            lock: lockPref.cgg,
            lockSam: lockPref.sam
        }));

    } catch (e) { /* ignoro */ }
}

['gifScale', 'gifFps', 'exportSmooth', 'gifLimit', 'gifLimitMp'].forEach(id => document.getElementById(id).addEventListener('change', () => {

    saveExportPrefs();

    refreshSamInfo();

    updateExportInfo();
}));

// slider e numero restano allineati (il numero accetta anche valori digitati a mano)
bgEls.range.addEventListener('input', () => {

    bgEls.num.value = bgEls.range.value;

    refreshBgPreview();
});

bgEls.num.addEventListener('input', () => {

    const v = Math.min(100, Math.max(0, Number(bgEls.num.value) || 0));

    bgEls.range.value = v;

    refreshBgPreview();
});

bgEls.num.addEventListener('change', () => {

    // se il campo e' vuoto o fuori misura lo riporto a un valore valido
    const v = Math.min(100, Math.max(0, Number(bgEls.num.value) || 0));

    bgEls.num.value = v;
    bgEls.range.value = v;

    refreshBgPreview();
    saveExportPrefs();
});

bgEls.range.addEventListener('change', saveExportPrefs);

bgEls.color.addEventListener('input', refreshBgPreview);
bgEls.color.addEventListener('change', () => { refreshBgPreview(); saveExportPrefs(); });

bgEls.all.addEventListener('change', saveExportPrefs);

document.getElementById('gifSoft').addEventListener('change', saveExportPrefs);

refreshBgPreview();

uiReady = true;

updateExportInfo();

/*
    Area di esportazione: uguale per TUTTE le animazioni dell'unita'
    (idle, move, atk e completa), cosi' i file hanno la stessa
    dimensione e il personaggio sta sempre nello stesso punto.

    - automatica: contiene tutti i frame di tutte le animazioni caricate;
    - fissa: W x H scelti da te (utile per avere la stessa dimensione
      anche tra unita' diverse; i piedi stanno in basso, a circa l'80%).
*/

function exportBox(shifts, forceAuto = false) {

    // forceAuto: area stretta attorno all'animazione, qualunque area sia scelta nel pannello (zoom automatico del WebP)
    if (!forceAuto && areaEls.screen.checked) return screenBox();

    if (!forceAuto && document.getElementById('areaFixed').checked) {

        const box = fixedBox();

        // avviso se l'area e' troppo piccola per qualche frame
        for (const name of state.animNames) {

            const seq = state.sequences[name];

            if (!seq || !seq.length) continue;

            const b = sequenceBounds(seq, state.framesDB, shifts);

            if (b.x < box.x || b.y < box.y || b.x + b.w > box.x + box.w || b.y + b.h > box.y + box.h) {

                console.warn(`L'area fissa ${box.w}x${box.h} taglia l'animazione ${name}`, b);

                state.areaWarning = true;
            }
        }

        return box;
    }

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

    for (const name of state.animNames) {

        const seq = state.sequences[name];

        if (!seq || !seq.length) continue;

        const b = sequenceBounds(seq, state.framesDB, shifts);

        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
    }

    if (!(x0 <= x1)) return sequenceBounds(state.sequences[state.current], state.framesDB, shifts);

    // misure pari: i video non amano i pixel dispari
    const w = Math.ceil(x1 - x0);
    const h = Math.ceil(y1 - y0);

    return { x: x0, y: y0, w: w + (w % 2), h: h + (h % 2) };
}

/*
    ESPORTAZIONE "A FLUSSO"

    Prima tutti i fotogrammi (pixel grezzi, 4 byte per pixel) restavano
    in memoria fino alla fine: con animazioni lunghe o ingrandite si
    arrivava a gigabyte e il browser dava "Out of memory".

    Ora: si calcola solo il PIANO (area, numero di fotogrammi, tempi),
    poi ogni fotogramma viene disegnato, passato subito all'encoder
    (che lo comprime) e buttato. In memoria c'e' un solo fotogramma
    grezzo alla volta, qualunque sia la lunghezza dell'animazione.

    mode:
      'gif'      colori sopra lo sfondo scelto (GIF opaca)
      'gif-mask' come sopra + maschera 1 bit (GIF con sfondo trasparente)
      'alpha'    trasparenza vera (APNG / video trasparente)
*/

/*
    GIF FLUIDA ANCHE CON AREE ENORMI

    Il browser, a ogni fotogramma, decodifica la GIF sull'INTERA tela, anche
    se cambia solo un angolo: il costo e' proporzionale ai pixel della tela
    (circa 3 ms per megapixel, misurato), non al contenuto. A 50 fps ne
    hai 20 ms per fotogramma: oltre ~4-6 megapixel la GIF rallenta e scatta.
    Con il limite attivo, se la tela supera i megapixel scelti si riduce
    l'ingrandimento (stessa inquadratura, stessi valori CSS, meno pixel).
*/

function gifMaxMp() {

    if (!document.getElementById('gifLimit').checked) return 0;

    const v = Number(document.getElementById('gifLimitMp').value);

    return Number.isFinite(v) && v > 0 ? Math.min(30, v) : 3;
}

function limitScale(box, scale, maxMp) {

    if (!maxMp || !(box.w > 0) || !(box.h > 0)) return scale;

    return box.w * box.h * scale * scale > maxMp * 1e6
        ? Math.sqrt(maxMp * 1e6 / (box.w * box.h))
        : scale;
}

function exportPlan(scale, maxMp = 0, forceBox = null) {

    const sequence = state.sequences[state.current];

    const shifts = activeShifts();

    // forceBox: area misurata sull'animazione vera (zoom automatico del WebP)
    const box = forceBox || exportBox(shifts);

    scale = limitScale(box, scale, maxMp);

    const width = Math.max(1, Math.round(box.w * scale));
    const height = Math.max(1, Math.round(box.h * scale));

    if (Math.max(width, height) > 4096) {

        throw new Error(`L'area e' troppo grande (${width}×${height} px, massimo 4096). Aumenta lo zoom, riduci l'area o l'ingrandimento.`);
    }

    const totalTicks = sequenceTotalTicks(sequence);

    // durata del loop in centesimi di secondo (unita' di GIF e APNG)
    const totalCs = totalTicks * state.tickMs / 10;

    // frame intermedi: si sceglie qui, a prescindere dal "Morbido" dello schermo
    const smooth = document.getElementById('exportSmooth').checked;

    // riconoscimento dell'ombra (per la GIF con la sola ombra a puntini)
    const isShadow = makeShadowTest();

    return { sequence, shifts, box, scale, width, height, totalTicks, totalCs, smooth, isShadow };
}

/*
    Come si riconosce l'ombra, per QUALSIASI unita' (ogni CGG e' fatto a
    modo suo: l'ombra non e' sempre l'ultimo pezzo, non ha sempre le stesse
    misure, ci sono righe vuote...). Si guarda il ritaglio dello sheet:

    - e' un'ellisse bassa e larga (larghezza almeno il doppio dell'altezza);
    - e' scura (nera o grigio scuro: bagliori, fuoco, fumo, personaggio sono
      chiari o colorati);
    - sta a terra (il bordo basso e' vicino all'origine del personaggio);
    - e' a fusione normale (i bagliori sono additivi).

    Tutto il resto resta netto, senza puntini.
*/

function makeShadowTest() {

    const img = Renderer.image;

    const cache = new Map();

    let cv = null;

    const darkSprite = (p) => {

        const key = p.sx + ',' + p.sy + ',' + p.w + ',' + p.h;

        let v = cache.get(key);

        if (v !== undefined) return v;

        v = false;

        try {

            if (!cv) cv = document.createElement('canvas');

            cv.width = p.w;
            cv.height = p.h;

            const cx = cv.getContext('2d', { willReadFrequently: true });

            cx.clearRect(0, 0, p.w, p.h);
            cx.drawImage(img, p.sx, p.sy, p.w, p.h, 0, 0, p.w, p.h);

            const d = cx.getImageData(0, 0, p.w, p.h).data;

            let sumA = 0, sumL = 0, maxC = 0;

            for (let i = 0; i < d.length; i += 4) {

                const a = d[i + 3];

                if (a < 8) continue;

                sumA += a;
                sumL += (d[i] + d[i + 1] + d[i + 2]) / 3 * a;

                // i pixel quasi trasparenti hanno colori imprecisi: non contano
                if (a >= 64) maxC = Math.max(maxC, d[i], d[i + 1], d[i + 2]);
            }

            v = sumA > 0 && sumL / sumA <= 110 && maxC <= 150;

        } catch (e) {

            v = false;
        }

        cache.set(key, v);

        return v;
    };

    // .sam: l'ombra e' il pezzo piatto che sta sotto a tutto in quasi tutti i frame
    // (come per il CGG), qualunque colore abbia il disegno
    const samKeys = state.samMode ? state.samShadowKeys : null;

    return (p) => {

        if (p && p.sam && samKeys && p.blendMode !== 1 && p.h >= 2 && p.w >= p.h * 2 && !Number(p.rad) && samKeys.has(pieceKey(p))) return true;

        if (!img || !p || p.blendMode === 1) return false;

        if (!(p.h >= 2 && p.w >= 8 && p.w >= p.h * 2 && p.w <= 160)) return false;

        if (Number(p.rotate) || Number(p.rad)) return false;

        // CGG: i piedi sono nell'origine, quindi l'ombra ha il bordo basso vicino a 0.
        // Nei .sam l'origine sta dove vuole l'unita' (l'ombra puo' essere anche a y = 100):
        // li' contano solo forma e colore del ritaglio.
        if (!p.sam) {

            const bottom = (Number(p.y) || 0) + p.h;

            if (bottom < -20 || bottom > 40) return false;
        }

        return darkSprite(p);
    };
}

function planFrames(plan, fps) {

    // almeno 2 cs per fotogramma (i browser rallentano i valori piu' bassi)
    const n = Math.max(1, Math.min(
        Math.floor(plan.totalCs / 2),
        Math.round(plan.totalCs * fps / 100)
    ));

    // i ritardi sommano esattamente la durata del loop
    const delays = [];

    for (let k = 0; k < n; k++) {
        delays.push(Math.round((k + 1) * plan.totalCs / n) - Math.round(k * plan.totalCs / n));
    }

    plan.n = n;
    plan.delays = delays;

    return plan;
}

function framePieces(plan, k) {

    const { index, t } = sampleSequence(plan.sequence, k * plan.totalTicks / plan.n);

    return composeFrame({
        sequence: plan.sequence,
        framesDB: state.framesDB,
        shifts: plan.shifts,
        index,
        t,
        smooth: plan.smooth
    }) || [];
}

const readPixels = (cv) =>
    cv.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, cv.width, cv.height).data;

/*
    Pixel RGBA del fotogramma k (un solo buffer: dopo l'uso si butta).

    mode:
    - 'gif'       sfondo pieno: i colori si calcolano sopra il colore di
                  sfondo, cosi' i pixel semitrasparenti (ombra, bagliori)
                  non diventano pieni;
    - 'gif-mask'  sfondo trasparente (opacita' 0%), tutto o niente: i pixel
                  oltre meta' diventano pieni (l'ombra diventa una macchia
                  nera), gli altri spariscono;
    - 'gif-shadow' sfondo trasparente e puntini SOLO sull'ombra: tutto il
                  resto resta netto (tutto o niente);
    - 'gif-alpha' la GIF ha solo "trasparente o pieno", quindi ogni
                  semitrasparenza (ombra, bagliori, sfondo con opacita'
                  intermedia) e' simulata con una retinatura a puntini FISSA
                  (stessa griglia in ogni fotogramma, niente rumore che
                  sfarfalla): a schermo l'ombra resta leggera come nel WebM;
    - 'alpha'     trasparenza vera (APNG, PNG); `bg` puo' essere un
                  colore css con alpha (rgba) oppure null.
*/

// matrice di Bayer 8x8: soglie 0..1 per la retinatura ordinata
const BAYER8 = (() => {

    let m = [[0]];

    for (let n = 1; n < 8; n *= 2) {

        const next = [];

        for (let y = 0; y < n * 2; y++) {

            next.push([]);

            for (let x = 0; x < n * 2; x++) {

                const base = m[y % n][x % n] * 4;
                const quad = (y < n ? 0 : 2) + (x < n ? 0 : 1);

                next[y].push(base + [0, 2, 3, 1][quad]);
            }
        }

        m = next;
    }

    return Float32Array.from(m.flat(), v => (v + 0.5) / 64);
})();

function hexToRgb(hex) {

    const v = parseInt(String(hex).replace('#', ''), 16) || 0;

    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function framePixels(plan, k, mode, bg, canvas, maskCanvas, alpha = 1) {

    const pieces = framePieces(plan, k);

    if (mode === 'gif-shadow') {

        /*
            Sfondo trasparente, retinatura SOLO sull'ombra: il personaggio
            e gli effetti restano netti (tutto o niente, come 'gif-mask');
            l'ombra, che sta sotto, e' semitrasparente a puntini.
        */

        const body = [];
        const shad = [];

        for (const p of pieces) (plan.isShadow(p) ? shad : body).push(p);

        Renderer.renderToCanvas(body, plan.box, plan.scale, null, canvas);

        const data = readPixels(canvas);

        let sh = null;

        if (shad.length) {

            Renderer.renderToCanvas(shad, plan.box, plan.scale, null, maskCanvas);

            sh = readPixels(maskCanvas);
        }

        const [br, bgc, bb] = hexToRgb(bg);

        const w = canvas.width;

        for (let p = 0, i = 0; p < data.length; p += 4, i++) {

            const m = data[p + 3] / 255;

            if (m >= 0.5) {

                // personaggio: colore fuso con lo sfondo scelto (niente aloni), pieno
                data[p] = Math.round(data[p] * m + br * (1 - m));
                data[p + 1] = Math.round(data[p + 1] * m + bgc * (1 - m));
                data[p + 2] = Math.round(data[p + 2] * m + bb * (1 - m));
                data[p + 3] = 255;

                continue;
            }

            let s = sh ? sh[p + 3] / 255 : 0;

            if (s < 0.06) s = 0;
            else if (s > 0.94) s = 1;

            if (s > BAYER8[((((i / w) | 0) & 7) << 3) | ((i % w) & 7)]) {

                data[p] = sh[p];
                data[p + 1] = sh[p + 1];
                data[p + 2] = sh[p + 2];
                data[p + 3] = 255;

            } else {

                data[p + 3] = 0;
            }
        }

        return data;
    }

    if (mode === 'gif-alpha') {

        // solo i pezzi, su fondo trasparente; lo sfondo si compone qui
        Renderer.renderToCanvas(pieces, plan.box, plan.scale, null, canvas);

        const data = readPixels(canvas);

        const [br, bgc, bb] = hexToRgb(bg);

        const w = canvas.width;

        for (let p = 0, i = 0; p < data.length; p += 4, i++) {

            let m = data[p + 3] / 255;

            // quasi vuoto / quasi pieno: niente puntini sparsi sui bordi
            if (m < 0.06) m = 0;
            else if (m > 0.94) m = 1;

            const back = (1 - m) * alpha;            // quanto sfondo si vede
            const a = m + back;                      // opacita' del risultato

            if (a <= BAYER8[((((i / w) | 0) & 7) << 3) | ((i % w) & 7)]) {

                data[p + 3] = 0;                     // puntino "vuoto"
                continue;
            }

            data[p] = Math.round((data[p] * m + br * back) / a);
            data[p + 1] = Math.round((data[p + 1] * m + bgc * back) / a);
            data[p + 2] = Math.round((data[p + 2] * m + bb * back) / a);
            data[p + 3] = 255;
        }

        return data;
    }

    if (mode === 'gif' || mode === 'gif-mask') {

        Renderer.renderToCanvas(pieces, plan.box, plan.scale, bg, canvas);

        const data = readPixels(canvas);

        if (mode === 'gif-mask') {

            Renderer.renderToCanvas(pieces, plan.box, plan.scale, null, maskCanvas);

            const mask = readPixels(maskCanvas);

            for (let p = 3; p < data.length; p += 4) {
                data[p] = mask[p] >= 128 ? 255 : 0;
            }
        }

        return data;
    }

    Renderer.renderToCanvas(pieces, plan.box, plan.scale, bg || null, canvas);

    return readPixels(canvas);
}


async function saveFile(blob, fileName, description, mime, ext) {

    /*
        La finestra "Salva con nome" e' permessa solo subito dopo un clic:
        dopo qualche secondo di lavoro (video, APNG lunghi) Chrome la
        rifiuta. In quel caso il file si scarica direttamente.
    */

    if (window.showSaveFilePicker) {

        try {

            const handle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{ description, accept: { [mime]: [ext] } }]
            });

            const writable = await handle.createWritable();

            await writable.write(blob);

            await writable.close();

            return;

        } catch (error) {

            if (error.name === 'AbortError') return;

            console.warn('Salva con nome non disponibile, scarico direttamente:', error);
        }
    }

    const a = document.createElement('a');

    a.href = URL.createObjectURL(blob);

    a.download = fileName;

    document.body.appendChild(a);

    a.click();

    a.remove();

    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}


/*
    Sfondo scelto (colore + opacita' 0-100%):
    - bg        colore esadecimale
    - bgAlpha   0..1
    - bgFill    colore css con alpha da disegnare sotto i pezzi (null se 0%)
    - fillAll   come bgFill, ma solo se e' spuntato "anche APNG / PNG"
                (altrimenti null: restano trasparenti come prima)
*/

function backgroundOptions() {

    const bg = document.getElementById('gifBg').value;

    const pct = Number(document.getElementById('bgAlpha').value);

    const bgAlpha = Math.min(1, Math.max(0, (Number.isFinite(pct) ? pct : 100) / 100));

    const [r, g, b] = hexToRgb(bg);

    const bgFill = bgAlpha <= 0
        ? null
        : (bgAlpha >= 1 ? bg : `rgba(${r}, ${g}, ${b}, ${bgAlpha})`);

    return {
        bg,
        bgAlpha,
        bgFill,
        gifSoft: document.getElementById('gifSoft').value,
        fillAll: document.getElementById('bgAll').checked ? bgFill : null
    };
}


/*
    Esegue una esportazione: controlla che l'animazione sia avviata,
    blocca il pulsante e mostra l'avanzamento.
*/

async function runExport(button, job) {

    const sequence = state.sequences[state.current];

    if (!state.isPlaying || !sequence || sequence.length === 0) {

        alert("Avvia l'animazione prima di esportare!");

        return;
    }

    const label = button.innerText;

    const exportButtons = [btnGif, btnApng, btnZip, btnVideo, btnWebp, btnSite];

    exportButtons.forEach(b => b.disabled = true);

    const onStatus = (text) => { button.innerText = text; };

    try {

        await job({
            fps: Number(document.getElementById('gifFps').value) || 50,
            scale: exportScale(),
            ...backgroundOptions(),
            gifMaxMp: gifMaxMp(),
            onStatus
        });

    } catch (error) {

        console.error("Errore esportazione:", error);

        alert("Errore durante l'esportazione: " + (error && error.message ? error.message : error));

    } finally {

        exportButtons.forEach(b => b.disabled = false);

        button.innerText = label;

        if (state.areaWarning) {

            state.areaWarning = false;

            alert("Attenzione: l'area fissa e' troppo piccola e taglia una parte dell'animazione. Aumenta larghezza / altezza.");
        }
    }
}


// ---- GIF ----
//
// La GIF ha una sola palette per tutti i fotogrammi: prima passata =
// solo l'istogramma dei colori (su al massimo 120 fotogrammi sparsi:
// i colori di un'unita' si ripetono), seconda passata = codifica.

btnGif.onclick = () => runExport(btnGif, async (o) => {

    const plan = planFrames(exportPlan(o.scale, o.gifMaxMp), o.fps);

    // 100% = sfondo pieno, 0% = trasparente, in mezzo = puntini (la GIF non ha mezze trasparenze)
    // sfondo trasparente: puntini solo sull'ombra (consigliato), su ombra e bagliori, oppure tutto o niente
    const mode = o.bgAlpha >= 1
        ? 'gif'
        : (o.bgAlpha > 0
            ? 'gif-alpha'
            : (o.gifSoft === 'all' ? 'gif-alpha' : (o.gifSoft === 'off' ? 'gif-mask' : 'gif-shadow')));

    const canvas = document.createElement('canvas');
    const maskCanvas = document.createElement('canvas');

    const pb = createPaletteBuilder();

    const samples = Math.min(plan.n, 120);

    for (let s = 0; s < samples; s++) {

        const k = Math.floor(s * plan.n / samples);

        pb.add(framePixels(plan, k, mode, o.bg, canvas, maskCanvas, o.bgAlpha));

        if (s % 4 === 0) {
            o.onStatus(`Analizzo i colori… ${s + 1}/${samples}`);
            await pause0();
        }
    }

    // l'indice 0 della palette e' sempre "trasparente": serve ai fotogrammi ridotti
    const gw = createGifWriter(plan.width, plan.height, pb.finish(true));

    for (let k = 0; k < plan.n; k++) {

        gw.addFrame(framePixels(plan, k, mode, o.bg, canvas, maskCanvas, o.bgAlpha), plan.delays[k]);

        if (k % 2 === 0) {
            o.onStatus(`Creo la GIF… ${k + 1}/${plan.n}`);
            await pause0();
        }
    }

    await saveFile(
        gw.finish(),
        `${fileLabel()}.gif`, 'GIF animata', 'image/gif', '.gif'
    );
});


// ---- APNG: trasparenza vera ----

btnApng.onclick = () => runExport(btnApng, async (o) => {

    const plan = planFrames(exportPlan(o.scale), o.fps);

    const canvas = document.createElement('canvas');

    const aw = createAPNGWriter(plan.width, plan.height, plan.n);

    for (let k = 0; k < plan.n; k++) {

        await aw.addFrame(framePixels(plan, k, 'alpha', o.fillAll, canvas), plan.delays[k]);

        if (k % 2 === 0) {
            o.onStatus(`Creo l'APNG… ${k + 1}/${plan.n}`);
            await pause0();
        }
    }

    await saveFile(
        aw.finish(),
        `${fileLabel()}.png`, 'PNG animato (APNG)', 'image/png', '.png'
    );
});


/*
    WebM: il browser lo registra in tempo reale e i fotogrammi arrivano a intervalli
    irregolari (da 8 a 40 ms invece dei 20 ms della GIF): sembra che "mangi" dei frame.
    Qui il file registrato viene rimontato con i tempi esatti della GIF e con la durata
    scritta nell'intestazione (senza, i lettori lo trattano come infinito).
    Se qualcosa non torna, chi chiama usa il file cosi' com'e'.
*/

// ---- piccoli attrezzi per leggere/scrivere EBML (il contenitore di WebM) ----

function ebmlReader(b) {

    const readId = (p) => {

        if (p >= b.length) return null;

        let n = 1, m = 0x80;

        while (n <= 4 && !(b[p] & m)) { m >>= 1; n++; }

        if (n > 4 || p + n > b.length) return null;

        let v = 0;

        for (let i = 0; i < n; i++) v = v * 256 + b[p + i];

        return { id: v, len: n };
    };

    const readSize = (p) => {

        if (p >= b.length) return null;

        let n = 1, m = 0x80;

        while (n <= 8 && !(b[p] & m)) { m >>= 1; n++; }

        if (n > 8 || p + n > b.length) return null;

        let v = b[p] & (m - 1);
        let ones = (b[p] & (m - 1)) === (m - 1);

        for (let i = 1; i < n; i++) {

            v = v * 256 + b[p + i];

            if (b[p + i] !== 0xff) ones = false;
        }

        return { size: v, len: n, unknown: ones };
    };

    // intestazione di un elemento: id, dove inizia il contenuto, grandezza
    const header = (p) => {

        const id = readId(p);

        if (!id) return null;

        const sz = readSize(p + id.len);

        if (!sz) return null;

        return { id: id.id, idLen: id.len, sizeLen: sz.len, size: sz.size, unknown: sz.unknown, data: p + id.len + sz.len };
    };

    return { header };
}

function ebmlSize(value, minLen) {

    let len = minLen;

    while (len < 8 && value >= Math.pow(2, 7 * len) - 1) len++;

    const out = new Uint8Array(len);

    let v = value;

    for (let i = len - 1; i >= 0; i--) {

        out[i] = v % 256;
        v = Math.floor(v / 256);
    }

    out[0] |= 0x80 >> (len - 1);

    return out;
}

function ebmlIdBytes(id) {

    const n = id > 0xFFFFFF ? 4 : id > 0xFFFF ? 3 : id > 0xFF ? 2 : 1;

    const out = new Uint8Array(n);

    let v = id;

    for (let i = n - 1; i >= 0; i--) {

        out[i] = v % 256;
        v = Math.floor(v / 256);
    }

    return out;
}

// elemento = id + grandezza + contenuto (pezzi da unire)
function ebmlWrap(id, parts) {

    const idb = ebmlIdBytes(id);

    let len = 0;

    for (const p of parts) len += p.length;

    const sz = ebmlSize(len, 1);

    const out = new Uint8Array(idb.length + sz.length + len);

    out.set(idb, 0);
    out.set(sz, idb.length);

    let w = idb.length + sz.length;

    for (const p of parts) { out.set(p, w); w += p.length; }

    return out;
}

// intero senza segno, con meno byte possibile
function ebmlUInt(value) {

    let n = 1;

    while (n < 8 && value >= Math.pow(256, n)) n++;

    const out = new Uint8Array(n);

    let v = value;

    for (let i = n - 1; i >= 0; i--) {

        out[i] = v % 256;
        v = Math.floor(v / 256);
    }

    return out;
}

// intero con segno (complemento a due), con meno byte possibile
function ebmlSInt(value) {

    let n = 1;

    while (n < 8 && (value < -Math.pow(2, 8 * n - 1) || value >= Math.pow(2, 8 * n - 1))) n++;

    const out = new Uint8Array(n);

    let v = value < 0 ? value + Math.pow(2, 8 * n) : value;

    for (let i = n - 1; i >= 0; i--) {

        out[i] = v % 256;
        v = Math.floor(v / 256);
    }

    return out;
}

function ebmlFloat64(value) {

    const out = new Uint8Array(8);

    new DataView(out.buffer).setFloat64(0, value);

    return out;
}

const WEBM_CLUSTER_CHILD = new Set([0xE7, 0xA3, 0xA0, 0xA7, 0xAB, 0xAF, 0x5854, 0xEC, 0xBF]);

/*
    Rimonta il WebM: ogni fotogramma registrato (in ordine) prende il tempo dato in "times"
    (millisecondi dall'inizio), la durata e' "durationMs". Se i fotogrammi registrati sono
    meno di quelli mandati (il browser ne ha saltato qualcuno), ognuno viene abbinato a
    quello mandato piu' vicino nel tempo ("submit" = quando e' stato mandato ciascuno).
    Restituisce il nuovo file, oppure null se il file non e' come ci si aspetta.
*/

function retimeWebm(bytes, times, submit, durationMs) {

    try {

        const b = bytes;
        const { header } = ebmlReader(b);

        const ebml = header(0);

        if (!ebml || ebml.id !== 0x1A45DFA3) return null;

        const ebmlEnd = ebml.data + ebml.size;

        const seg = header(ebmlEnd);

        if (!seg || seg.id !== 0x18538067) return null;

        const segEnd = seg.unknown ? b.length : Math.min(b.length, seg.data + seg.size);

        let scale = 1000000;

        const pre = [];           // elementi prima dei Cluster, copiati cosi' come sono
        const infoKept = [];      // contenuto di Info senza la durata
        let infoSeen = false;

        const blocks = [];

        const uint = (pos, len) => {

            let v = 0;

            for (let i = 0; i < len; i++) v = v * 256 + b[pos + i];

            return v;
        };

        // un Block / SimpleBlock: numero di traccia (1 byte o piu'), tempo relativo, flag
        const blockInfo = (data) => {

            let n = 1, m = 0x80;

            while (n <= 8 && !(b[data] & m)) { m >>= 1; n++; }

            const rel = (b[data + n] << 8 | b[data + n + 1]) << 16 >> 16;

            return { trackLen: n, rel, flags: b[data + n + 2] };
        };

        let p = seg.data;

        while (p < segEnd) {

            const h = header(p);

            if (!h) break;

            const end = h.unknown ? segEnd : Math.min(segEnd, h.data + h.size);

            if (h.id === 0x1F43B675) {

                // Cluster (puo' avere la grandezza "sconosciuta": finisce al primo elemento che non e' suo)
                let q = h.data;
                let tc = 0;

                while (q < end) {

                    const c = header(q);

                    if (!c) { q = end; break; }

                    if (h.unknown && !WEBM_CLUSTER_CHILD.has(c.id)) break;

                    const cEnd = Math.min(end, c.data + c.size);

                    if (c.id === 0xE7) {

                        tc = uint(c.data, cEnd - c.data);

                    } else if (c.id === 0xA3) {

                        const bi = blockInfo(c.data);

                        blocks.push({
                            old: tc + bi.rel,
                            key: !!(bi.flags & 0x80),
                            simple: true,
                            trackLen: bi.trackLen,
                            payload: b.slice(c.data, cEnd)
                        });

                    } else if (c.id === 0xA0) {

                        const kids = [];

                        let block = null;
                        let ref = null;

                        for (let r = c.data; r < cEnd;) {

                            const k = header(r);

                            if (!k) break;

                            const kEnd = Math.min(cEnd, k.data + k.size);

                            if (k.id === 0xA1) {

                                const bi = blockInfo(k.data);

                                block = { old: tc + bi.rel, trackLen: bi.trackLen };

                                kids.push({ kind: 'block', payload: b.slice(k.data, kEnd) });

                            } else if (k.id === 0xFB) {

                                let v = uint(k.data, kEnd - k.data);

                                if (b[k.data] & 0x80) v -= Math.pow(2, 8 * (kEnd - k.data));

                                ref = v;

                                kids.push({ kind: 'ref' });

                            } else {

                                kids.push({ kind: 'raw', bytes: b.slice(r, kEnd) });
                            }

                            r = kEnd;
                        }

                        if (!block) return null;

                        blocks.push({ old: block.old, key: ref === null, simple: false, trackLen: block.trackLen, kids, ref });
                    }

                    q = cEnd;
                }

                p = h.unknown ? q : end;

                continue;
            }

            if (h.unknown) return null;

            if (h.id === 0x1549A966) {

                // Info: se ci sono scala del tempo e durata, la durata si rifa'
                infoSeen = true;

                for (let r = h.data; r < end;) {

                    const k = header(r);

                    if (!k) return null;

                    const kEnd = Math.min(end, k.data + k.size);

                    if (k.id === 0x2AD7B1) {

                        const v = uint(k.data, kEnd - k.data);

                        if (v > 0) scale = v;
                    }

                    if (k.id !== 0x4489) infoKept.push(b.slice(r, kEnd));

                    r = kEnd;
                }

            } else if (h.id === 0x114D9B74 || h.id === 0xEC || h.id === 0x1C53BB6B) {

                // SeekHead, riempimenti e Cues: le posizioni cambiano, si scartano

            } else {

                pre.push(b.slice(p, end));
            }

            p = end;
        }

        if (!infoSeen || !blocks.length) return null;

        // ---- a quale fotogramma mandato corrisponde ogni fotogramma registrato
        const msOf = (ticks) => ticks * scale / 1e6;

        const n = times.length;

        const map = [];

        if (blocks.length === n) {

            for (let i = 0; i < n; i++) map.push(i);

        } else {

            const off = msOf(blocks[0].old) - submit[0];

            let last = -1;

            for (const blk of blocks) {

                const t = msOf(blk.old) - off;

                let best = -1, bd = Infinity;

                for (let k = last + 1; k < n; k++) {

                    const d = Math.abs(submit[k] - t);

                    if (d < bd) { bd = d; best = k; } else break;
                }

                map.push(best);

                if (best >= 0) last = best;
            }
        }

        const ticksOf = (ms) => Math.round(ms * 1e6 / scale);

        const kept = [];

        blocks.forEach((blk, i) => { if (map[i] >= 0) kept.push({ blk, t: ticksOf(times[map[i]]) }); });

        if (!kept.length) return null;

        // tempo vecchio -> nuovo (serve a rifare i riferimenti dei fotogrammi)
        const newOf = new Map();

        kept.forEach(({ blk, t }) => newOf.set(blk.old, t));

        // ---- Cluster nuovi: al massimo 30 secondi ciascuno
        const clusters = [];

        let cur = null;

        kept.forEach(({ blk, t }, idx) => {

            if (!cur || t - cur.tc > Math.min(30000, ticksOf(30000))) {

                cur = { tc: t, items: [] };

                clusters.push(cur);
            }

            const rel = t - cur.tc;

            const payload = blk.simple ? blk.payload : blk.kids.find(k => k.kind === 'block').payload;

            const pl = new Uint8Array(payload);

            pl[blk.trackLen] = (rel >> 8) & 0xff;
            pl[blk.trackLen + 1] = rel & 0xff;

            if (blk.simple) {

                cur.items.push(ebmlWrap(0xA3, [pl]));

            } else {

                const parts = [];

                for (const k of blk.kids) {

                    if (k.kind === 'block') {

                        parts.push(ebmlWrap(0xA1, [pl]));

                    } else if (k.kind === 'ref') {

                        const target = newOf.has(blk.old + blk.ref)
                            ? newOf.get(blk.old + blk.ref)
                            : (idx > 0 ? kept[idx - 1].t : t);

                        parts.push(ebmlWrap(0xFB, [ebmlSInt(target - t)]));

                    } else {

                        parts.push(k.bytes);
                    }
                }

                cur.items.push(ebmlWrap(0xA0, parts));
            }
        });

        const clusterBytes = clusters.map(c =>
            ebmlWrap(0x1F43B675, [ebmlWrap(0xE7, [ebmlUInt(c.tc)]), ...c.items])
        );

        const info = ebmlWrap(0x1549A966, [...infoKept, ebmlWrap(0x4489, [ebmlFloat64(durationMs * 1e6 / scale)])]);

        const children = [info, ...pre, ...clusterBytes];

        let total = 0;

        for (const c of children) total += c.length;

        const segHead = [ebmlIdBytes(0x18538067), ebmlSize(total, 8)];

        let len = ebmlEnd;

        for (const s of segHead) len += s.length;

        const out = new Uint8Array(len + total);

        out.set(b.subarray(0, ebmlEnd), 0);

        let w = ebmlEnd;

        for (const s of segHead) { out.set(s, w); w += s.length; }

        for (const c of children) { out.set(c, w); w += c.length; }

        return { bytes: out, blocks: blocks.length };

    } catch (e) {

        return null;
    }
}


// ---- VIDEO WebM (registrato dal canvas) ----
//
// Ogni fotogramma che cambia si disegna con calma, uno dopo l'altro (nessuno viene saltato,
// anche con immagini grandi), e poi il file viene rimontato con i tempi esatti della GIF:
// dura quanto la GIF con i suoi tempi (UN giro dell'animazione) e la durata e' scritta nel
// file. I fotogrammi uguali al precedente non si ricodificano: restano a schermo.

btnVideo.onclick = () => runExport(btnVideo, async (o) => {

    if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder non disponibile');
    }

    const transparent = document.getElementById('videoTransparent').checked;

    const plan = planFrames(exportPlan(o.scale), o.fps);
    const { width, height, delays } = plan;

    // canvas di lavoro con accelerazione grafica (non viene letto)
    const work = document.createElement('canvas');
    work.width = width;
    work.height = height;
    work.getContext('2d');

    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

    const mime = types.find(t => MediaRecorder.isTypeSupported(t));

    // tempo di inizio di ogni fotogramma = somma dei ritardi della GIF (centesimi di secondo)
    const starts = [];

    let acc = 0;

    for (const d of delays) { starts.push(acc * 10); acc += d; }

    const loopMs = acc * 10;

    // solo i fotogrammi che cambiano davvero
    const frames = [];

    let lastSig = null;

    for (let k = 0; k < delays.length; k++) {

        const sig = Eraser.sig(framePieces(plan, k));

        if (sig === lastSig) continue;

        lastSig = sig;

        frames.push({ k, ms: starts[k] });
    }

    const times = frames.map(f => f.ms);

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // una registrazione: un fotogramma ogni "pace" ms (almeno), lasciando al codificatore
    // il tempo di lavorare. I tempi veri non dipendono da questa pausa.
    const attempt = async (pace, note) => {

        const cv = document.createElement('canvas');

        cv.width = width;
        cv.height = height;

        const ctx = cv.getContext('2d');

        const stream = cv.captureStream(0);

        const track = stream.getVideoTracks()[0];

        const rec = new MediaRecorder(stream, {
            mimeType: mime,
            videoBitsPerSecond: 20_000_000
        });

        const chunks = [];

        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

        const stopped = new Promise(resolve => { rec.onstop = resolve; });

        rec.start(1000);           // consegna i dati ogni secondo invece che tutti alla fine

        const t0 = performance.now();

        const submit = [];

        for (let i = 0; i < frames.length; i++) {

            const s = performance.now();

            submit.push(s - t0);

            Renderer.renderToCanvas(framePieces(plan, frames[i].k), plan.box, plan.scale, transparent ? null : o.bgFill, work);

            ctx.clearRect(0, 0, width, height);

            ctx.drawImage(work, 0, 0);

            if (track.requestFrame) track.requestFrame();

            const cost = performance.now() - s;

            o.onStatus(`Registro il video${note}… ${Math.round(i / frames.length * 100)}%`);

            await sleep(Math.max(pace, Math.min(400, cost * 2 + 20)));
        }

        await sleep(200);

        rec.stop();

        await stopped;

        stream.getTracks().forEach(t => t.stop());

        return { raw: new Uint8Array(await new Blob(chunks).arrayBuffer()), submit };
    };

    // immagini grandi: piu' pausa. Se il browser salta lo stesso qualche fotogramma
    // si riprova piu' piano (al massimo 3 volte).
    let pace = Math.max(40, Math.min(200, Math.round(width * height / 25000)));

    let result = null;

    for (let tries = 0; tries < 3; tries++) {

        const rec = await attempt(pace, tries ? ' (riprovo piu\' piano)' : '');

        const res = retimeWebm(rec.raw, times, rec.submit, loopMs);

        result = res ? res.bytes : rec.raw;

        // file non riconosciuto, oppure nessun fotogramma perso: basta
        if (!res || res.blocks >= times.length) break;

        pace = Math.min(600, pace * 2.5);
    }

    await saveFile(
        new Blob([result], { type: 'video/webm' }),
        `${fileLabel()}.webm`, 'Video WebM', 'video/webm', '.webm'
    );
});


// ---- ZIP con un PNG trasparente per ogni frame della timeline ----
//
// Un PNG per ogni frame che vedi nella timeline (quindi per ogni riga
// del CGS), esattamente come nel file: niente campionamento a 50 fps e
// niente passaggi "morbidi" tra un frame e l'altro. Area, zoom e
// posizione sono quelli scelti per le altre esportazioni.

btnZip.onclick = () => runExport(btnZip, async (o) => {

    const plan = exportPlan(o.scale);

    const total = plan.sequence.length;

    const canvas = document.createElement('canvas');

    const zip = createZipWriter();

    const digits = Math.max(4, String(total).length);

    for (let k = 0; k < total; k++) {

        const pieces = composeFrame({
            sequence: plan.sequence,
            framesDB: state.framesDB,
            shifts: plan.shifts,
            index: k,
            t: 0,
            smooth: false
        }) || [];

        Renderer.renderToCanvas(pieces, plan.box, plan.scale, o.fillAll, canvas);

        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));

        zip.addFile(
            `${fileLabel()}_${String(k + 1).padStart(digits, '0')}.png`,
            new Uint8Array(await blob.arrayBuffer())
        );

        if (k % 2 === 0) {
            o.onStatus(`Creo i PNG… ${k + 1}/${total}`);
            await pause0();
        }
    }

    await saveFile(
        zip.finish(),
        `${fileLabel()}_frames.zip`, 'ZIP di PNG', 'application/zip', '.zip'
    );
});


// ============================================================
// GAME LOOP
//
// Passo fisso a 60 tick al secondo con accumulatore.
//
// Prima: "se sono passati almeno 16,67 ms dall'ultimo tick..."
// con rAF a 60 Hz gli intervalli reali sono 16,5 / 16,8 / 16,6 ms:
// ogni volta che uno e' appena sotto la soglia il tick saltava al
// frame successivo (33 ms) e il tempo residuo veniva buttato via.
// Risultato: durate irregolari = scatti.
//
// Ora il tempo trascorso si accumula e ogni tick viene consumato
// esattamente quando e' dovuto, qualunque sia la frequenza dello
// schermo (60, 120, 144 Hz...).
// ============================================================

let loopStarted = false;


function gameLoop(timestamp) {

    requestAnimationFrame(
        gameLoop
    );


    if (!state.isPlaying) {
        return;
    }


    let dt =
        timestamp - state.lastTime;

    state.lastTime = timestamp;


    if (state.isPaused) {
        return;
    }


    // scheda in background / rallentamento: non recuperare di colpo
    if (dt > 100 || dt < 0) {
        dt = state.tickMs;
    }


    const sequence =
        state.sequences[state.current];


    if (
        !sequence ||
        sequence.length === 0
    ) {
        return;
    }


    state.accum += dt;


    let changed = false;


    while (state.accum >= state.tickMs) {

        state.accum -= state.tickMs;

        state.ticks++;


        /*
            Quando abbiamo raggiunto la durata
            prevista dal CGS passiamo al frame
            successivo.
        */

        if (
            state.ticks >=
            state.currentFrameDuration
        ) {

            state.ticks -= state.currentFrameDuration;

            state.frameIndex =
                (
                    state.frameIndex +
                    1
                ) % sequence.length;

            state.currentFrameDuration =
                frameDuration(sequence[state.frameIndex]);

            changed = true;
        }
    }


    // con "Morbido" si ridisegna a ogni schermata, altrimenti solo a ogni cambio frame
    if (
        changed ||
        state.smooth
    ) {

        renderCurrentFrame();
    }
}


initAssembler();

// ============================================================
// VISTA DEI FRAME ESPORTATI
//
// Mostra, uno per uno e su scacchiera, i frame che finiscono davvero in
// GIF, APNG e video (stesso calcolo dell'esportazione: stessi pezzi,
// stesse impostazioni) e segna quelli con pezzi semitrasparenti o vuoti.
// I frame identici di fila sono uniti (come nel video).
// ============================================================

const fvEls = {
    overlay: document.getElementById('fvOverlay'),
    grid: document.getElementById('fvGrid'),
    summary: document.getElementById('fvSummary'),
    hint: document.getElementById('fvHint'),
    only: document.getElementById('fvOnlyFx'),
    netto: document.getElementById('fvNetto'),
    big: document.getElementById('fvBig'),
    bigCv: document.getElementById('fvBigCv'),
    bigInfo: document.getElementById('fvBigInfo'),
    bigPieces: document.getElementById('fvBigPieces'),
    smooth: document.getElementById('fvSmooth'),
    play: document.getElementById('fvPlay'),
    bg: document.getElementById('fvBg')
};

const fv = { token: 0, plan: null, items: [], crop: null, cur: -1, playing: false, raf: 0 };

function fvStopPlay() {

    fv.playing = false;

    if (fv.raf) cancelAnimationFrame(fv.raf);

    fv.raf = 0;

    fvEls.play.textContent = '▶ Riproduci';
}

// riproduce i frame con i loro tempi veri (tutto il giro dell'animazione, in ciclo)
function fvStartPlay() {

    const items = fv.items;

    if (!items.length) return;

    const last = items[items.length - 1];

    const loop = last.start + last.dur;

    if (!(loop > 0)) return;

    fvStopPlay();

    fv.playing = true;

    fvEls.play.textContent = '❚❚ Pausa';

    const t0 = performance.now() - (fv.cur >= 0 ? items[fv.cur].start : 0);

    const step = (now) => {

        if (!fv.playing) return;

        const t = (now - t0) % loop;

        let lo = 0, hi = items.length - 1;

        while (lo < hi) {

            const mid = (lo + hi + 1) >> 1;

            if (items[mid].start <= t) lo = mid; else hi = mid - 1;
        }

        if (lo !== fv.cur) fvShowBig(lo, true);

        fv.raf = requestAnimationFrame(step);
    };

    fv.raf = requestAnimationFrame(step);
}

// pezzi visibili e pezzi semitrasparenti di un frame (l'ombra e' sempre semitrasparente: non conta)
function fvInspect(plan, pieces) {

    let visible = 0;

    const fx = [];

    for (const p of pieces) {

        const o = Number.isFinite(p.opacity) ? p.opacity : 100;

        if (o <= 0.5 || !(p.w > 0) || !(p.h > 0)) continue;

        visible++;

        if (o < 99.5 && !plan.isShadow(p)) fx.push({ w: Math.round(p.w), h: Math.round(p.h), o: Math.round(o), add: p.blendMode === 1 });
    }

    return { visible, fx };
}

const fvTime = (ms) => (ms / 1000).toFixed(2).replace('.', ',') + ' s';

function fvClose() {

    fv.token++;

    fvStopPlay();

    fvEls.overlay.style.display = 'none';
    fvEls.big.style.display = 'none';
    fvEls.grid.textContent = '';

    fv.items = [];
}

async function openFrameView() {

    const sequence = state.sequences[state.current];

    if (!sequence || sequence.length === 0) {

        alert('Carica prima un\'unità.');

        return;
    }

    const token = ++fv.token;

    fvStopPlay();

    fvEls.overlay.style.display = 'flex';
    fvEls.big.style.display = 'none';
    fvEls.grid.textContent = '';
    fvEls.hint.textContent = '';
    fvEls.hint.className = 'fv-hint';
    fvEls.netto.style.display = 'none';
    fvEls.summary.textContent = 'Preparo i frame…';

    fvEls.smooth.checked = document.getElementById('exportSmooth').checked;

    await pause0();

    // stesso piano dell'esportazione (se l'area e' enorme ne uso una piu' piccola: serve solo a guardare)
    const areaWarn = state.areaWarning;

    let plan = null;

    for (const sc of [exportScale(), 1, 0.2]) {

        try {

            plan = planFrames(exportPlan(sc), Number(document.getElementById('gifFps').value) || 50);

            break;

        } catch (e) { /* area troppo grande: riprovo con meno pixel */ }
    }

    state.areaWarning = areaWarn;

    if (!plan) {

        fvEls.summary.textContent = 'Non riesco a preparare i frame.';

        return;
    }

    // frame diversi tra loro, in ordine, con tempo di inizio e durata
    const items = [];

    let lastSig = null;
    let acc = 0;

    for (let k = 0; k < plan.n; k++) {

        const pieces = framePieces(plan, k);

        const sig = Eraser.sig(pieces);

        if (sig !== lastSig) {

            lastSig = sig;

            items.push({ k, start: acc * 10, dur: 0, pieces, ...fvInspect(plan, pieces) });
        }

        acc += plan.delays[k];

        const last = items[items.length - 1];

        last.dur = acc * 10 - last.start;

        if (k % 40 === 0) {

            fvEls.summary.textContent = `Preparo i frame… ${Math.round(k / plan.n * 100)}%`;

            await pause0();

            if (token !== fv.token) return;
        }
    }

    // inquadratura: stretta sul personaggio (l'area di esportazione puo' essere molto piu' grande)
    const box = plan.box;

    const ts1 = Math.min(1, 360 / Math.max(box.w, box.h));

    const probe = document.createElement('canvas');

    let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;

    for (let i = 0; i < items.length; i++) {

        Renderer.renderToCanvas(items[i].pieces, box, ts1, null, probe);

        const d = probe.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, probe.width, probe.height).data;

        const W = probe.width;

        for (let y = 0; y < probe.height; y++) {

            for (let x = 0; x < W; x++) {

                if (d[(y * W + x) * 4 + 3] > 8) {

                    if (x < ax0) ax0 = x;
                    if (x > ax1) ax1 = x;
                    if (y < ay0) ay0 = y;
                    if (y > ay1) ay1 = y;
                }
            }
        }

        if (i % 30 === 0) {

            await pause0();

            if (token !== fv.token) return;
        }
    }

    let crop = box;

    if (ax0 <= ax1) {

        const m = 6;

        const x0 = Math.max(box.x, box.x + ax0 / ts1 - m);
        const y0 = Math.max(box.y, box.y + ay0 / ts1 - m);
        const x1 = Math.min(box.x + box.w, box.x + (ax1 + 1) / ts1 + m);
        const y1 = Math.min(box.y + box.h, box.y + (ay1 + 1) / ts1 + m);

        crop = { x: x0, y: y0, w: Math.max(8, x1 - x0), h: Math.max(8, y1 - y0) };
    }

    const ts2 = Math.max(0.3, Math.min(4, 300 / crop.w, 220 / crop.h));

    fv.plan = plan;
    fv.items = items;
    fv.crop = crop;
    fv.cur = -1;

    // riepilogo e suggerimento
    const nFx = items.filter(it => it.fx.length).length;
    const nEmpty = items.filter(it => it.visible === 0).length;

    const soft = Number(samEls.soft.value);

    const softName = samEls.soft.selectedOptions[0].text.replace(/\s*\(.*\)\s*$/, '');

    // frame del FILE (senza Morbido ne' dissolvenze) che hanno davvero pezzi semitrasparenti
    let nFile = 0;

    for (let i = 0; i < plan.sequence.length; i++) {

        const base = composeFrame({
            sequence: plan.sequence,
            framesDB: state.framesDB,
            shifts: plan.shifts,
            index: i,
            t: 0,
            smooth: false
        }) || [];

        if (fvInspect(plan, base).fx.length) nFile++;
    }

    fvEls.summary.textContent = `${items.length} frame diversi (${plan.n} fotogrammi in tutto)`
        + ` · con pezzi semitrasparenti: ${nFx} · vuoti: ${nEmpty}`
        + ` · Passaggio tra i disegni: ${softName}`
        + ` · Esporta fluido: ${plan.smooth ? 'sì' : 'no'}`;

    const lines = [];

    if (nEmpty) lines.push(`⚠ ${nEmpty} frame vuoti (nessun pezzo visibile): sono evidenziati in rosso.`);

    if (nFx) {

        if (soft > 0) {

            lines.push(`⚠ ${nFx} frame hanno pezzi semitrasparenti (bordo arancione). `
                + (nFile
                    ? `Nel file ce ne sono solo ${nFile} (frame del file); il resto lo crea il «Passaggio tra i disegni» (ora su «${softName}»).`
                    : `Nel file nessun pezzo è semitrasparente: li crea il «Passaggio tra i disegni» (ora su «${softName}»).`)
                + ' Premi il pulsante «Netto» in alto per toglierli.');

            fvEls.netto.style.display = '';

        } else {

            lines.push(`${nFx} frame hanno pezzi semitrasparenti (bordo arancione): ${nFile ? `nel file ce ne sono ${nFile} frame (trasparenza scritta nel file stesso, l'ombra non conta)` : 'vengono dall\'opacità tra un frame e l\'altro dell\'esportazione fluida'}. Clicca un frame per vedere quale pezzo e quanto.`);
        }

    } else if (!nEmpty) {

        lines.push('Nessun pezzo semitrasparente e nessun frame vuoto: tutti i frame sono pieni.');
    }

    fvEls.hint.textContent = lines.join(' ');

    fvEls.hint.className = 'fv-hint' + ((nEmpty || (nFx && soft > 0)) ? ' warn' : '');

    // le miniature, a gruppi per non bloccare la pagina
    for (let i = 0; i < items.length; i++) {

        const it = items[i];

        const tile = document.createElement('div');

        tile.className = 'fv-tile' + (it.visible === 0 ? ' empty' : (it.fx.length ? ' fx' : ''));

        const cv = document.createElement('canvas');

        Renderer.renderToCanvas(it.pieces, crop, ts2, null, cv);

        const cap = document.createElement('div');

        cap.textContent = `#${i + 1} · ${fvTime(it.start)} · ${it.dur} ms`;

        tile.append(cv, cap);

        if (it.visible === 0 || it.fx.length) {

            const badge = document.createElement('div');

            badge.className = 'fv-badge';

            badge.textContent = it.visible === 0
                ? '⚠ VUOTO'
                : `⚠ ${it.fx.length} pezz${it.fx.length === 1 ? 'o' : 'i'} semitrasparent${it.fx.length === 1 ? 'e' : 'i'} (min ${Math.min(...it.fx.map(f => f.o))}%)`;

            tile.append(badge);
        }

        tile.onclick = () => fvShowBig(i);

        fvEls.grid.append(tile);

        if (i % 12 === 11) {

            await pause0();

            if (token !== fv.token) return;
        }
    }
}

function fvShowBig(i, keepPlaying) {

    if (!fv.items.length) return;

    if (!keepPlaying) fvStopPlay();

    i = (i + fv.items.length) % fv.items.length;

    fv.cur = i;

    const it = fv.items[i];

    const crop = fv.crop;

    const fit = Math.min((window.innerWidth - 60) / crop.w, (window.innerHeight - 230) / crop.h);

    const ts = fit >= 1 ? Math.floor(fit) : Math.max(0.2, fit);

    fvEls.big.style.display = 'flex';

    // sfondo: scacchiera (si vede la trasparenza) oppure quello scelto per l'esportazione
    const bg = fvEls.bg.value === 'export' ? (backgroundOptions().bgFill || null) : null;

    Renderer.renderToCanvas(it.pieces, crop, ts, bg, fvEls.bigCv);

    fvEls.bigInfo.textContent = `Frame ${i + 1} di ${fv.items.length} · ${fvTime(it.start)} · dura ${it.dur} ms`;

    fvEls.bigPieces.style.color = (it.visible === 0 || it.fx.length) ? '#fbbf24' : '#9ca3af';

    fvEls.bigPieces.textContent = it.visible === 0
        ? '⚠ Frame vuoto: nessun pezzo visibile.'
        : (it.fx.length
            ? '⚠ Pezzi semitrasparenti: ' + it.fx.map(f => `${f.w}×${f.h} px al ${f.o}%${f.add ? ' (luce additiva)' : ''}`).join(' · ')
            : 'Tutti i pezzi sono pieni (l\'ombra a terra è sempre un po\' trasparente).');
}

document.getElementById('viewFrames').onclick = openFrameView;
document.getElementById('fvClose').onclick = fvClose;
document.getElementById('fvBigClose').onclick = () => { fvStopPlay(); fvEls.big.style.display = 'none'; };
document.getElementById('fvPlayAll').onclick = () => { fvShowBig(0, true); fvStartPlay(); };
fvEls.play.onclick = () => { if (fv.playing) fvStopPlay(); else fvStartPlay(); };
fvEls.bg.addEventListener('change', () => { if (fv.cur >= 0) fvShowBig(fv.cur, true); });
document.getElementById('fvPrev').onclick = () => fvShowBig(fv.cur - 1);
document.getElementById('fvNext').onclick = () => fvShowBig(fv.cur + 1);

// stessa casella «Esporta fluido» del pannello di esportazione (non il «Morbido» dello schermo)
fvEls.smooth.addEventListener('change', () => {

    const box = document.getElementById('exportSmooth');

    box.checked = fvEls.smooth.checked;

    box.dispatchEvent(new Event('change'));

    openFrameView();
});

fvEls.only.addEventListener('change', () => fvEls.grid.classList.toggle('only-fx', fvEls.only.checked));

fvEls.netto.onclick = () => {

    samEls.soft.value = '0';

    samEls.soft.dispatchEvent(new Event('change'));

    openFrameView();
};

window.addEventListener('keydown', (e) => {

    if (fvEls.overlay.style.display === 'none') return;

    const bigOpen = fvEls.big.style.display !== 'none';

    if (e.key === 'Escape') {

        if (bigOpen) { fvStopPlay(); fvEls.big.style.display = 'none'; } else fvClose();

        e.preventDefault();

    } else if (bigOpen && e.key === ' ') {

        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

        if (fv.playing) fvStopPlay(); else fvStartPlay();

        e.preventDefault();

    } else if (bigOpen && e.key === 'ArrowLeft') {

        fvShowBig(fv.cur - 1);

        e.preventDefault();

    } else if (bigOpen && e.key === 'ArrowRight') {

        fvShowBig(fv.cur + 1);

        e.preventDefault();
    }
});


// ============================================================
// WEBP ANIMATO (per iPhone e per chi non vuole la GIF)
//
// - colori pieni e trasparenza vera (la GIF ha solo 256 colori);
// - tempi esatti al millisecondo, un solo giro dell'animazione, in ciclo;
// - fotogrammi identici di fila uniti in uno solo (file piu' leggero);
// - "senza perdita" (consigliato): nessun colore rovinato o "bruciato".
//
// Zoom automatico: area stretta attorno al personaggio (uguale per
// tutte le animazioni) e ingrandimento a NUMERO INTERO, cosi' il
// personaggio riempie il video e i pixel restano nitidi. Senza questo,
// un'animazione piccola in una tela grande viene rimpicciolita dal
// telefono e sembra sfocata.
// ============================================================

const webpEls = {
    compact: document.getElementById('webpCompact'),
    maxKb: document.getElementById('webpMaxKb'),
    zoom: document.getElementById('webpZoom'),
    target: document.getElementById('webpTarget'),
    quality: document.getElementById('webpQuality')
};

// ingrandimento intero che porta il lato lungo vicino a "target" pixel (mai oltre i limiti del browser).
// Se l'animazione e' cosi' grande che nemmeno 1x ci sta, si rimpicciolisce il minimo necessario:
// meglio un po' piu' piccola che tagliata.
function webpZoomScale(box, target) {

    const long = Math.max(box.w, box.h);

    let k = Math.max(1, Math.floor(target / long));

    while (k > 1 && (box.w * k > 4096 || box.h * k > 4096 || box.w * box.h * k * k > 12e6)) k--;

    if (k === 1 && (box.w > 4096 || box.h > 4096 || box.w * box.h > 12e6)) {

        return Math.min(4096 / long, Math.sqrt(12e6 / (box.w * box.h))) * 0.999;
    }

    return k;
}

/*
    AREA DELL'ANIMAZIONE, MISURATA SUI PIXEL

    Non basta la geometria dei pezzi (rotazioni, scie, bagliori, passaggi
    morbidi tra due frame possono uscire dal rettangolo calcolato): si
    disegnano davvero tutti i fotogrammi di tutte le animazioni dell'unita'
    (gli stessi dell'esportazione) e si cercano i pixel visibili piu' esterni
    a sinistra, destra, sopra e sotto. Cosi' l'area e' quella che serve a
    QUESTA unita' (stretta o larga, alta o lunga) e non viene tagliato niente.
    Se un pezzo arriva al bordo dell'area di prova, la prova si rifa piu' larga.
*/

async function measureTightBox(fps, onProgress, { only = null, smooth = document.getElementById('exportSmooth').checked } = {}) {

    const shifts = activeShifts();

    const base = exportBox(shifts, true);

    // solo = una animazione sola (WebP compatto); altrimenti tutte quelle dell'unita'
    const names = only
        ? [only].filter(n => state.sequences[n] && state.sequences[n].length)
        : [...state.animNames, 'all'].filter((n, i, a) => a.indexOf(n) === i && state.sequences[n] && state.sequences[n].length);

    // tutti i fotogrammi diversi di tutte le animazioni (gli stessi campioni dell'esportazione)
    const jobs = [];

    const seen = new Set();

    for (const name of names) {

        const sequence = state.sequences[name];

        const totalTicks = sequenceTotalTicks(sequence);

        const plan = planFrames({ sequence, shifts, totalTicks, totalCs: totalTicks * state.tickMs / 10, smooth }, fps);

        for (let k = 0; k < plan.n; k++) {

            const pieces = framePieces(plan, k);

            const sig = Eraser.sig(pieces);

            if (seen.has(sig)) continue;

            seen.add(sig);

            jobs.push(pieces);
        }

        await pause0();
    }

    let pad = Math.max(60, Math.max(base.w, base.h) * 0.5);

    const cv = document.createElement('canvas');

    for (let attempt = 0; attempt < 4; attempt++) {

        const probe = { x: base.x - pad, y: base.y - pad, w: base.w + 2 * pad, h: base.h + 2 * pad };

        const ts = Math.min(1, 1200 / Math.max(probe.w, probe.h));

        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

        let touches = false;

        for (let i = 0; i < jobs.length; i++) {

            Renderer.renderToCanvas(jobs[i], probe, ts, null, cv);

            const W = cv.width;
            const H = cv.height;

            const d = new Uint32Array(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data.buffer);

            // l'alfa e' il byte piu' alto del pixel (RGBA in memoria, little-endian)
            for (let y = 0; y < H; y++) {

                const row = y * W;

                for (let x = 0; x < W; x++) {

                    if ((d[row + x] >>> 24) >= 3) {

                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                }
            }

            if (i % 15 === 14) {

                if (onProgress) onProgress(i + 1, jobs.length);

                await pause0();
            }
        }

        if (x0 > x1) return base;   // nessun pixel visibile: tengo la geometria

        touches = x0 <= 1 || y0 <= 1 || x1 >= cv.width - 2 || y1 >= cv.height - 2;

        if (touches && attempt < 3) {

            pad *= 2.5;

            continue;
        }

        // un po' d'aria attorno (almeno 4 unita' e almeno due pixel di misura), misure pari
        const m = Math.ceil(2 / ts) + 4;

        const ex0 = probe.x + x0 / ts - m;
        const ey0 = probe.y + y0 / ts - m;
        const ex1 = probe.x + (x1 + 1) / ts + m;
        const ey1 = probe.y + (y1 + 1) / ts + m;

        const w = Math.ceil(ex1 - ex0);
        const h = Math.ceil(ey1 - ey0);

        return { x: ex0, y: ey0, w: w + (w % 2), h: h + (h % 2) };
    }

    return base;
}

/*
    I fotogrammi veri del WebP: di fila identici = uno solo, con la durata sommata.
    Ritorna [{ pieces, ms }].
*/
function webpKeyFrames(plan) {

    const list = [];

    let sig = null;

    for (let k = 0; k < plan.n; k++) {

        const pieces = framePieces(plan, k);

        const s = Eraser.sig(pieces);

        if (list.length && s === sig) {

            list[list.length - 1].ms += plan.delays[k] * 10;

        } else {

            list.push({ pieces, ms: plan.delays[k] * 10 });

            sig = s;
        }
    }

    return list;
}

btnWebp.onclick = () => runExport(btnWebp, async (o) => {

    const compact = webpEls.compact.checked;

    const zoom = webpEls.zoom.checked;

    const target = Math.min(4096, Math.max(200, Number(webpEls.target.value) || 1080));

    const quality = Math.min(1, Math.max(0.5, Number(webpEls.quality.value) || 1));

    const maxKb = Math.max(0, Number(webpEls.maxKb.value) || 0);

    // sfondo: colore + opacita' scelti (0% = trasparente). Il WebP ha la trasparenza vera.
    const hasAlpha = !o.bgFill || o.bgAlpha < 1;

    let plan;
    let box;
    let k = 0;
    let q = quality;

    if (compact) {

        // area stretta attorno a QUESTA animazione e solo i fotogrammi veri (niente passaggi intermedi)
        o.onStatus('Misuro l\'animazione…');

        box = await measureTightBox(o.fps, (i, n) => o.onStatus(`Misuro l'animazione… ${Math.round(i / n * 100)}%`), { only: state.current, smooth: false });

        k = zoom ? webpZoomScale(box, target) : o.scale;

        plan = exportPlan(k, 0, box);

        plan.smooth = false;

        planFrames(plan, o.fps);

    } else if (zoom) {

        o.onStatus('Misuro l\'animazione…');

        box = await measureTightBox(o.fps, (i, n) => o.onStatus(`Misuro l'animazione… ${Math.round(i / n * 100)}%`));

        k = webpZoomScale(box, target);

        plan = planFrames(exportPlan(k, 0, box), o.fps);

    } else {

        plan = planFrames(exportPlan(o.scale), o.fps);

        box = plan.box;
    }

    // fotogrammi identici di fila = uno solo, con la durata sommata
    const frames = webpKeyFrames(plan);

    const durations = frames.map(f => f.ms);

    const build = (scale, quality, label) => encodeAnimatedWebp({
        width: Math.max(1, Math.round(box.w * scale)),
        height: Math.max(1, Math.round(box.h * scale)),
        count: frames.length,
        durations,
        render: (i, cv) => { Renderer.renderToCanvas(frames[i].pieces, box, scale, o.bgFill, cv); },
        hasAlpha,
        quality,
        subRect: compact,
        loop: 0,
        onProgress: async (i, n) => {

            o.onStatus(`Creo il WebP… ${i}/${n}${label}`);

            if (i % 2 === 0) await pause0();
        }
    });

    let result = await build(plan.scale, q, '');

    let scale = plan.scale;

    // peso massimo: prima si abbassa lo zoom (a numeri interi, i pixel restano nitidi), poi la qualita'
    let reduced = false;

    if (compact && maxKb > 0) {

        for (let attempt = 0; attempt < 10 && result.blob.size / 1024 > maxKb; attempt++) {

            reduced = true;

            const kb = result.blob.size / 1024;

            if (scale > 1.0001) {

                // il peso cresce con l'area (zoom al quadrato), con un po' di margine
                const guess = Math.floor(scale * Math.sqrt(maxKb / kb) * 0.97);

                scale = Math.max(1, Math.min(Math.ceil(scale) - 1, guess));

            } else if (q > 0.62) {

                q = q >= 1 ? 0.92 : Math.max(0.6, q - 0.12);

            } else {

                break;
            }

            result = await build(scale, q, ` · prova ×${Math.round(scale * 100) / 100}`);
        }
    }

    const width = Math.max(1, Math.round(box.w * scale));
    const height = Math.max(1, Math.round(box.h * scale));

    const kbFinal = Math.round(result.blob.size / 1024);

    const info = document.getElementById('webpInfo');

    if (info) {

        const parts = [`Ultimo WebP: ${width}×${height} px`, `${kbFinal} KB`, `${result.frames} fotogrammi`];

        if (zoom || compact) parts.push(`zoom ×${Math.round(scale * 100) / 100}`);

        if (compact && reduced && scale < plan.scale) parts.push(`ridotto da ×${Math.round(plan.scale * 100) / 100} per stare sotto ${maxKb} KB`);

        if (compact && q < quality) parts.push(`qualità abbassata (${Math.round(q * 100)}%) per il limite di peso`);

        if (compact && maxKb > 0 && kbFinal > maxKb) parts.push(`ATTENZIONE: ancora sopra i ${maxKb} KB`);

        if (zoom || compact) parts.push('area misurata sull\'animazione: niente tagliato');

        info.textContent = parts.join(' · ');
    }

    await saveFile(
        result.blob,
        `${fileLabel()}.webp`, 'WebP animato', 'image/webp', '.webp'
    );
});

// scelte del WebP: ricordate dal browser
const WEBP_KEY = 'animator.webp';

try {

    const v = JSON.parse(localStorage.getItem(WEBP_KEY) || 'null');

    if (v) {

        if (v.compact === false) webpEls.compact.checked = false;
        if (Number(v.maxKb) >= 0 && v.maxKb !== undefined && v.maxKb !== null && v.maxKb !== '') webpEls.maxKb.value = Math.min(50000, Number(v.maxKb));
        if (v.zoom === false) webpEls.zoom.checked = false;
        if (Number(v.target) >= 200 && Number(v.target) <= 4096) webpEls.target.value = Number(v.target);
        if ([...webpEls.quality.options].some(op => op.value === String(v.quality))) webpEls.quality.value = String(v.quality);
    }

} catch (e) { /* ignoro */ }

[webpEls.compact, webpEls.maxKb, webpEls.zoom, webpEls.target, webpEls.quality].forEach(el => el.addEventListener('change', () => {

    try {

        localStorage.setItem(WEBP_KEY, JSON.stringify({
            compact: webpEls.compact.checked,
            maxKb: Number(webpEls.maxKb.value),
            zoom: webpEls.zoom.checked,
            target: Number(webpEls.target.value),
            quality: webpEls.quality.value
        }));

    } catch (e) { /* ignoro */ }
}));



// ============================================================
// ESPORTA PER IL SITO
//
// Crea in un colpo solo i 6 file che usa il sito (per ogni unita':
// default, idle e atk, ognuno in .webm per PC / Android e in .webp
// per iPhone / Safari), senza cambiare l'animazione:
//
//  - UNA SOLA TELA per le 3 animazioni: il rettangolo che contiene tutti i
//    pixel non trasparenti di tutti i fotogrammi di default + idle + atk,
//    piu' 4 pixel di margine, misurato a scala 1:1. Stessa larghezza, stessa
//    altezza, stesso punto di partenza: il personaggio fermo sta nello
//    stesso pixel in tutte e 3;
//  - scala 1:1 con lo sprite del gioco (niente ingrandimenti, niente
//    ricampionamenti), sfondo trasparente (qualunque sia lo sfondo scelto
//    per le altre esportazioni);
//  - solo i fotogrammi veri, con i loro tempi originali (al millisecondo),
//    ciclo infinito;
//  - WebP: animato, senza perdita, con trasparenza (ogni fotogramma salva
//    solo la parte che cambia: stessa immagine, file piu' leggero);
//  - WebM: VP9 con trasparenza (yuva420p), fatto dal browser fotogramma per
//    fotogramma (tempi esatti, niente registrazione in tempo reale).
//
// Alla fine si controllano i file veri (si rileggono) e si mostra il
// risultato: stessa tela, primo fotogramma, trasparenza, memoria dell'iPhone.
// ============================================================

const siteEls = {
    name: document.getElementById('siteName'),
    scale: document.getElementById('siteScale'),
    info: document.getElementById('siteInfo'),
    overlay: document.getElementById('siteOverlay'),
    report: document.getElementById('siteReport'),
    title: document.getElementById('siteTitle'),
    close: document.getElementById('siteClose')
};

const SITE_MARGIN = 4;

// ingrandimento massimo (a numero intero, pixel netti)
const SITE_MAX_SCALE = 4;

// l'iPhone decodifica ogni fotogramma a tela intera: larghezza x altezza x fotogrammi x 4 byte
const SITE_MEMORY_LIMIT = 300e6;

// tela riservata ai vecchi video ingranditi: il sito la riduce
const SITE_FORBIDDEN = { w: 2614, h: 1535 };

siteEls.name.addEventListener('input', () => { siteEls.name.dataset.edited = '1'; });

// grandezza scelta: ricordata dal browser
const SITE_SCALE_KEY = 'animator.siteScale';

try {

    const v = localStorage.getItem(SITE_SCALE_KEY);

    if (v && [...siteEls.scale.options].some(o => o.value === v)) siteEls.scale.value = v;

} catch (e) { /* ignoro */ }

siteEls.scale.addEventListener('change', () => {

    try { localStorage.setItem(SITE_SCALE_KEY, siteEls.scale.value); } catch (e) { /* ignoro */ }
});

siteEls.close.addEventListener('click', () => { siteEls.overlay.style.display = 'none'; });

// nome proposto per i file: la cartella (o il file) appena caricati
function guessUnitName(files) {

    const f = files.find(x => /\.sam$/i.test(x.name))
        || files.find(x => /cgg/i.test(x.name) && /\.(csv|cgg|txt)$/i.test(x.name))
        || files[0];

    if (!f) return;

    const parts = String(f._path || f.webkitRelativePath || f.name).split('/');

    const name = parts.length > 1 ? parts[parts.length - 2] : f.name.replace(/\.[^.]+$/, '');

    state.unitGuess = name;

    if (siteEls.name && !siteEls.name.dataset.edited) siteEls.name.value = name;
}

// "Fencer Vargas" -> "Fencer-Vargas" (nome di file)
function siteFileBase() {

    const raw = (siteEls.name.value || state.unitGuess || '').trim();

    const n = raw.replace(/[\\/:*?"<>|]+/g, ' ').trim().replace(/\s+/g, '-').replace(/^[-.]+|[-.]+$/g, '');

    return n || 'Unita';
}

/*
    Le 3 animazioni del sito. default = la "Completa" (idle + move + attack, con le ripetizioni
    scelte). Per un .sam si usano TUTTI i frame del file (non quelli ridotti dal "Frame da usare"):
    senza passaggi morbidi, i frame ridotti cambierebbero l'animazione.
*/
function siteSequences() {

    const seqOf = (k) => (state.samMode && state.samFull[k] && state.samFull[k].length) ? state.samFull[k] : state.sequences[k];

    const all = [];

    for (const name of state.animNames) {

        const seq = seqOf(name);

        if (!seq || !seq.length) continue;

        const n = repeatInputs[name]
            ? Math.max(0, Math.min(20, parseInt(repeatInputs[name].value, 10) || 0))
            : 1;

        for (let r = 0; r < n; r++) all.push(...seq);
    }

    return { default: all, idle: seqOf('idle') || [], atk: seqOf('atk') || [] };
}

// i fotogrammi veri di una sequenza: { pieces, ms, sig }. Di fila uguali = uno solo (durate sommate).
// I tempi sono quelli originali (ticks x ms per tick), arrotondati al millisecondo senza accumulare errori.
function siteKeyFrames(sequence) {

    const shifts = activeShifts();

    const list = [];

    let cum = 0;

    for (let i = 0; i < sequence.length; i++) {

        const before = Math.round(cum * state.tickMs);

        cum += frameDuration(sequence[i]);

        const ms = Math.max(1, Math.round(cum * state.tickMs) - before);

        const pieces = composeFrame({ sequence, framesDB: state.framesDB, shifts, index: i, t: 0, smooth: false }) || [];

        const sig = Eraser.sig(pieces);

        const last = list[list.length - 1];

        if (last && last.sig === sig) last.ms += ms;
        else list.push({ pieces, ms, sig });
    }

    return list;
}

/*
    LA TELA COMUNE, misurata sui pixel veri.

    Si disegnano tutti i fotogrammi diversi di default + idle + atk e si cercano i pixel non
    trasparenti piu' esterni (alfa > 0); il rettangolo e' quello, piu' 4 pixel per lato (e un pixel
    in piu' a destra / in basso se la misura e' dispari, per i video).

    Prima si misura a 1:1 (veloce); se la grandezza scelta e' maggiore (x2, x3, x4: ingrandimento
    a numero intero, pixel netti) si rimisura DAVVERO alla grandezza finale, solo attorno al
    personaggio: i pixel del file finale sono quelli misurati. Il margine e' di 4 pixel del file
    finale. L'origine del rettangolo e' un multiplo di 1/k di unita': i pixel dello sprite cadono
    sempre sulla griglia del file (nessuna sfocatura).
*/

// cerca i pixel visibili (alfa > 0) in tutti i fotogrammi disegnati dentro "probe" (rettangolo in coordinate
// dell'animatore) alla grandezza "scale"; ritorna i bordi in pixel del canvas di prova
async function siteScan(jobs, probe, scale, cv, onProgress) {

    let ax0 = Infinity, ay0 = Infinity, ax1 = -1, ay1 = -1;

    let W = 0, H = 0;

    for (let i = 0; i < jobs.length; i++) {

        Renderer.renderToCanvas(jobs[i], probe, scale, null, cv);

        W = cv.width;
        H = cv.height;

        const d = new Uint32Array(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data.buffer);

        // l'alfa e' il byte piu' alto del pixel (RGBA in memoria, little-endian)
        for (let y = 0; y < H; y++) {

            const row = y * W;

            for (let x = 0; x < W; x++) {

                if ((d[row + x] >>> 24) !== 0) {

                    if (x < ax0) ax0 = x;
                    if (x > ax1) ax1 = x;
                    if (y < ay0) ay0 = y;
                    if (y > ay1) ay1 = y;
                }
            }
        }

        if (i % 10 === 9) {

            if (onProgress) onProgress(i + 1, jobs.length);

            await pause0();
        }
    }

    return { ax0, ay0, ax1, ay1, W, H };
}

async function measureSiteBox(lists, sequences, onProgress, scaleChoice = 1) {

    const shifts = activeShifts();

    // punto di partenza: rettangolo dei pezzi (geometria), poi si misura davvero
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

    for (const seq of sequences) {

        if (!seq.length) continue;

        const b = sequenceBounds(seq, state.framesDB, shifts);

        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
    }

    const base = x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: -100, y: -200, w: 200, h: 220 };

    const jobs = [];

    const seen = new Set();

    for (const list of lists) {

        for (const fr of list) {

            if (seen.has(fr.sig)) continue;

            seen.add(fr.sig);

            jobs.push(fr.pieces);
        }
    }

    let pad = Math.max(60, Math.max(base.w, base.h) * 0.5);

    const cv = document.createElement('canvas');

    // ---- passo 1: a 1:1, su un'area di prova ampia
    let nat = null;

    for (let attempt = 0; attempt < 5 && !nat; attempt++) {

        const probe = {
            x: Math.floor(base.x - pad),
            y: Math.floor(base.y - pad),
            w: Math.ceil(base.w + 2 * pad) + 2,
            h: Math.ceil(base.h + 2 * pad) + 2
        };

        if (probe.w * probe.h > 60e6) throw new Error('Le animazioni escono troppo dal personaggio: area da misurare enorme.');

        const r = await siteScan(jobs, probe, 1, cv, onProgress);

        if (r.ax1 < 0) throw new Error('Nessun pixel visibile in nessun fotogramma.');

        // un pezzo arriva al bordo dell'area di prova: potrebbe continuare, si rifa piu' larga
        if (r.ax0 <= 0 || r.ay0 <= 0 || r.ax1 >= r.W - 1 || r.ay1 >= r.H - 1) {

            pad *= 2.5;

            continue;
        }

        nat = { x0: probe.x + r.ax0, y0: probe.y + r.ay0, x1: probe.x + r.ax1, y1: probe.y + r.ay1 };
    }

    if (!nat) throw new Error('Non riesco a misurare l\'animazione: arriva sempre al bordo dell\'area di prova.');

    const natW = nat.x1 - nat.x0 + 1;
    const natH = nat.y1 - nat.y0 + 1;

    const m = SITE_MARGIN;

    // ---- grandezza: x1, x2, x3, x4 oppure "auto" (la piu' grande che tiene ogni .webp sotto il limite dell'iPhone)
    let k = 1;

    if (scaleChoice === 'auto') {

        const most = Math.max(...lists.map(l => l.length));

        for (let c = SITE_MAX_SCALE; c >= 1; c--) {

            if ((natW * c + 2 * m + 1) * (natH * c + 2 * m + 1) * most * 4 <= SITE_MEMORY_LIMIT * 0.95) { k = c; break; }
        }

    } else {

        k = Math.max(1, Math.min(SITE_MAX_SCALE, Math.round(Number(scaleChoice) || 1)));
    }

    const finish = (X, Y, ax0, ay0, ax1, ay1) => {

        // X, Y = origine del canvas di prova in pixel del file; ax0.. = pixel visibili in quel canvas
        const contentW = ax1 - ax0 + 1;
        const contentH = ay1 - ay0 + 1;

        let w = contentW + 2 * m;
        let h = contentH + 2 * m;

        if (w % 2) w++;
        if (h % 2) h++;

        const fx = X + ax0 - m;
        const fy = Y + ay0 - m;

        return {
            // misure del file
            w,
            h,
            contentW,
            contentH,
            scale: k,
            // rettangolo da disegnare, in coordinate dell'animatore (a ingrandimento k dà esattamente w x h pixel)
            rx: fx / k,
            ry: fy / k,
            rw: w / k,
            rh: h / k,
            frames: jobs.length
        };
    };

    if (k === 1) return finish(0, 0, nat.x0, nat.y0, nat.x1, nat.y1);

    // ---- passo 2: si rimisura alla grandezza vera, solo attorno al personaggio
    let grow = 3;

    for (let attempt = 0; attempt < 5; attempt++) {

        const win = { x: nat.x0 - grow, y: nat.y0 - grow, w: natW + 2 * grow, h: natH + 2 * grow };

        const r = await siteScan(jobs, win, k, cv, onProgress);

        if (r.ax1 < 0) throw new Error('Nessun pixel visibile in nessun fotogramma.');

        if (r.ax0 <= 0 || r.ay0 <= 0 || r.ax1 >= r.W - 1 || r.ay1 >= r.H - 1) {

            grow = Math.ceil(grow * 2.5);

            continue;
        }

        return finish(win.x * k, win.y * k, r.ax0, r.ay0, r.ax1, r.ay1);
    }

    throw new Error('Non riesco a misurare l\'animazione alla grandezza scelta.');
}

// il rettangolo da disegnare (coordinate dell'animatore) e l'ingrandimento
const siteRenderBox = (box) => ({ x: box.rx, y: box.ry, w: box.rw, h: box.rh });

const siteRenderFrame = (pieces, box, cv) => Renderer.renderToCanvas(pieces, siteRenderBox(box), box.scale, null, cv);

// quanta memoria userebbe una .webp con "frames" fotogrammi a un'altra grandezza (stima)
function siteMemoryAt(box, frames, k) {

    const w = Math.ceil(box.contentW / box.scale * k) + 2 * SITE_MARGIN + 1;
    const h = Math.ceil(box.contentH / box.scale * k) + 2 * SITE_MARGIN + 1;

    return w * h * frames * 4;
}

// controllo preliminare (sincrono: serve prima di aprire la finestra della cartella)
function siteCheckReady() {

    if (!Renderer.image || !state.framesDB.length) return { error: 'Carica prima un\'unità (CGG + CGS + PNG oppure un .sam).' };

    const seqs = siteSequences();

    const missing = ['idle', 'atk'].filter(k => !seqs[k].length);

    if (missing.length) {

        return {
            error: `Manca l'animazione ${missing.join(' e ')}: il sito vuole default, idle e atk.`
                + (state.samMode ? `\nAnimazioni del file .sam: ${state.animNames.map(k => state.samLabels[k] || k).join(', ')}.` : '')
        };
    }

    if (!seqs.default.length) return { error: 'L\'animazione completa (default) è vuota: controlla le ripetizioni di Idle / Move / Attack.' };

    return { seqs };
}

const kbText = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB';

const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// primo fotogramma di una .webp letta DAL FILE (decodificatore del browser)
async function siteDecodeWebp(bytes) {

    if (typeof ImageDecoder === 'undefined') return null;

    const dec = new ImageDecoder({ data: bytes, type: 'image/webp' });

    try {

        await dec.tracks.ready;

        const { image } = await dec.decode({ frameIndex: 0 });

        const cv = document.createElement('canvas');

        cv.width = image.displayWidth;
        cv.height = image.displayHeight;

        const cx = cv.getContext('2d', { willReadFrequently: true });

        cx.drawImage(image, 0, 0);

        image.close();

        return { w: cv.width, h: cv.height, data: cx.getImageData(0, 0, cv.width, cv.height).data };

    } finally {

        dec.close();
    }
}

// primo fotogramma di un .webm letto DAL FILE (lettore video del browser, con la trasparenza)
async function siteDecodeWebm(blob) {

    const url = URL.createObjectURL(blob);

    const v = document.createElement('video');

    try {

        v.muted = true;
        v.preload = 'auto';
        v.src = url;

        await new Promise((ok, ko) => {

            v.onloadeddata = ok;
            v.onerror = () => ko(new Error('il browser non apre il .webm'));

            setTimeout(() => ko(new Error('il browser non apre il .webm (tempo scaduto)')), 15000);
        });

        // il fotogramma a 0 s e' gia' pronto; il salto serve solo ad averlo certo
        v.currentTime = 0;

        await new Promise(ok => { v.onseeked = ok; setTimeout(ok, 400); });

        const cv = document.createElement('canvas');

        cv.width = v.videoWidth;
        cv.height = v.videoHeight;

        const cx = cv.getContext('2d', { willReadFrequently: true });

        cx.drawImage(v, 0, 0);

        return { w: cv.width, h: cv.height, duration: v.duration, data: cx.getImageData(0, 0, cv.width, cv.height).data };

    } finally {

        v.removeAttribute('src');
        v.load();

        URL.revokeObjectURL(url);
    }
}

// riquadro dei pixel visibili (alfa oltre "thr") di un'immagine RGBA
function siteContentBox(img, thr = 0) {

    const { w, h, data } = img;

    let x0 = w, y0 = h, x1 = -1, y1 = -1;

    for (let y = 0; y < h; y++) {

        for (let x = 0; x < w; x++) {

            if (data[(y * w + x) * 4 + 3] > thr) {

                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }

    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// gli angoli (4x4 pixel) sono tutti trasparenti?
function siteCornersClear(img) {

    const { w, h, data } = img;

    const n = Math.min(4, w, h);

    for (const [cx, cy] of [[0, 0], [w - n, 0], [0, h - n], [w - n, h - n]]) {

        for (let y = 0; y < n; y++) {

            for (let x = 0; x < n; x++) {

                if (data[((cy + y) * w + cx + x) * 4 + 3] !== 0) return false;
            }
        }
    }

    return true;
}

const sameBox = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const boxText = (b) => b ? `${b.w}×${b.h} in (${b.x}, ${b.y})` : 'vuoto';

/*
    I CONTROLLI, fatti sui file veri appena creati (non sui fotogrammi che li hanno generati).
    Ritorna [{ level: 'ok'|'warn'|'bad', title, detail }]
*/
async function siteVerify(box, out, names) {

    const checks = [];

    const add = (level, title, detail = '') => checks.push({ level, title, detail });

    const wInfo = {};
    const mInfo = {};

    for (const n of names) {

        wInfo[n] = inspectWebp(out[n].webpBytes);
        mInfo[n] = inspectWebm(out[n].webmBytes);
    }

    // 1. WebP: stesse dimensioni
    const wDims = names.map(n => `${wInfo[n].width}×${wInfo[n].height}`);

    if (new Set(wDims).size === 1 && wInfo[names[0]].width === box.w && wInfo[names[0]].height === box.h) {

        add('ok', `Le 3 .webp hanno dimensioni identiche: ${wDims[0]} px`, 'stessa tela per default, idle e atk');

    } else {

        add('bad', 'Le .webp NON hanno le stesse dimensioni', names.map((n, i) => `${n}: ${wDims[i]}`).join(' · '));
    }

    // 2. WebM: stesse dimensioni
    const mDims = names.map(n => `${mInfo[n].width}×${mInfo[n].height}`);

    if (new Set(mDims).size === 1 && mInfo[names[0]].width === box.w && mInfo[names[0]].height === box.h) {

        add('ok', `I 3 .webm hanno dimensioni identiche: ${mDims[0]} px`, 'uguali anche a quelle delle .webp (stesso ritaglio comune)');

    } else {

        add('bad', 'I .webm NON hanno le stesse dimensioni', names.map((n, i) => `${n}: ${mDims[i]}`).join(' · '));
    }

    if (box.w === SITE_FORBIDDEN.w && box.h === SITE_FORBIDDEN.h) {

        add('bad', `La tela è ${SITE_FORBIDDEN.w}×${SITE_FORBIDDEN.h}: il sito la riduce`, 'quella misura è riservata ai vecchi video ingranditi');

    } else {

        add('ok', `La tela non è la ${SITE_FORBIDDEN.w}×${SITE_FORBIDDEN.h} riservata ai vecchi video`);
    }

    // 3. lettura vera dei file (decodificatori del browser)
    const wDec = {};
    const mDec = {};

    let decodeNote = '';

    for (const n of names) {

        try { wDec[n] = await siteDecodeWebp(out[n].webpBytes); } catch (e) { wDec[n] = null; decodeNote += ` .webp ${n}: ${e.message}.`; }

        try { mDec[n] = await siteDecodeWebm(out[n].webmBlob); } catch (e) { mDec[n] = null; decodeNote += ` .webm ${n}: ${e.message}.`; }
    }

    const wOk = names.every(n => wDec[n]);
    const mOk = names.every(n => mDec[n]);

    // 4. primo fotogramma: default e idle, il personaggio e' nello stesso punto
    const firstOf = (dec, n, fallback) => dec[n] || fallback[n];

    // se il browser non sa rileggere un file, si usa il primo fotogramma disegnato (lo si dice)
    const fallback = {};

    if (!wOk || !mOk) {

        const cv = document.createElement('canvas');

        for (const n of names) {

            siteRenderFrame(out[n].frames[0].pieces, box, cv);

            fallback[n] = { w: cv.width, h: cv.height, data: cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data };
        }
    }

    {
        const a = firstOf(wDec, 'default', fallback);
        const b = firstOf(wDec, 'idle', fallback);

        const ba = siteContentBox(a);
        const bb = siteContentBox(b);

        let identical = a.w === b.w && a.h === b.h;

        if (identical) {

            for (let i = 0; i < a.data.length; i++) { if (a.data[i] !== b.data[i]) { identical = false; break; } }
        }

        const src = wOk ? 'dal file .webp' : 'sul fotogramma disegnato (il browser non rilegge le .webp)';

        if (identical) add('ok', 'Primo fotogramma di default e idle: identico, il personaggio è nello stesso pixel', `riquadro ${boxText(ba)} · ${src}`);
        else if (sameBox(ba, bb)) add('ok', 'Primo fotogramma di default e idle: personaggio nello stesso punto', `riquadro ${boxText(ba)} (le pose differiscono di poco) · ${src}`);
        else add('warn', 'Primo fotogramma di default e idle: il personaggio NON è nello stesso punto', `default ${boxText(ba)} · idle ${boxText(bb)} · ${src}. Succede se il default non parte dall'idle (ripetizioni Idle a 0?) o se la posa è diversa.`);

        // stessa cosa nei .webm (con un pixel di tolleranza: il video e' compresso)
        if (mOk && (identical || sameBox(ba, bb))) {

            const ma = siteContentBox(mDec.default, 8);
            const mb = siteContentBox(mDec.idle, 8);

            const near = !!ma && !!mb && Math.abs(ma.x - mb.x) <= 1 && Math.abs(ma.y - mb.y) <= 1 && Math.abs(ma.w - mb.w) <= 1 && Math.abs(ma.h - mb.h) <= 1;

            if (near) add('ok', 'Anche nei .webm il primo fotogramma di default e idle sta nello stesso punto', `default ${boxText(ma)} · idle ${boxText(mb)}`);
            else add('warn', 'Nei .webm il primo fotogramma di default e idle è in punti diversi', `default ${boxText(ma)} · idle ${boxText(mb)}`);
        }
    }

    // 5. sfondo trasparente
    {
        const flags = names.every(n => wInfo[n].alpha) && names.every(n => mInfo[n].alphaMode === 1 && mInfo[n].alphaFrames === mInfo[n].frames);

        const corners = names.every(n => siteCornersClear(firstOf(wDec, n, fallback))) && (!mOk || names.every(n => siteCornersClear(mDec[n])));

        if (flags && corners) {

            add('ok', 'Sfondo trasparente (canale alfa) in tutti e 6 i file', `.webp: alfa dichiarato e angoli trasparenti · .webm: AlphaMode 1, alfa in ogni fotogramma${mOk ? ', angoli trasparenti' : ''}`);

        } else {

            add('bad', 'Lo sfondo NON risulta trasparente in tutti i file', `alfa dichiarato: ${flags ? 'sì' : 'NO'} · angoli trasparenti: ${corners ? 'sì' : 'NO'}`);
        }
    }

    // 6. memoria dell'iPhone
    {
        const parts = names.map(n => {

            const w = wInfo[n];

            return { n, bytes: w.width * w.height * w.frames * 4, frames: w.frames };
        });

        const over = parts.filter(p => p.bytes > SITE_MEMORY_LIMIT);

        const txt = parts.map(p => `${p.n}: ${box.w}×${box.h}×${p.frames} fotogrammi×4 = ${(p.bytes / 1e6).toFixed(1)} MB`).join(' · ');

        if (!over.length) add('ok', `Peso in memoria di ogni .webp sotto 300 MB (al massimo ${(Math.max(...parts.map(p => p.bytes)) / 1e6).toFixed(1)} MB)`, txt);
        else {

            // a quale grandezza ci starebbe?
            let fit = 0;

            for (let c = box.scale - 1; c >= 1 && !fit; c--) {

                if (over.every(p => siteMemoryAt(box, p.frames, c) <= SITE_MEMORY_LIMIT * 0.97)) fit = c;
            }

            const hint = fit
                ? `A ×${fit} starebbe sotto i 300 MB: cambia «Grandezza» e rifai l'esportazione, oppure scegli «Auto».`
                : (box.scale > 1 ? 'Anche a ×1 resterebbe sopra: l\'animazione ha troppi fotogrammi o la tela è troppo grande.' : 'L\'animazione ha troppi fotogrammi o la tela è troppo grande.');

            add('warn', `Peso in memoria SOPRA 300 MB: ${over.map(p => `${p.n} ${(p.bytes / 1e6).toFixed(0)} MB`).join(', ')}. Su iPhone ${over.length > 1 ? 'queste .webp potrebbero non vedersi' : 'questa .webp potrebbe non vedersi'}`, `${txt}. Non ho rimpicciolito il personaggio da solo. ${hint}`);
        }
    }

    // 7. formato delle .webp
    {
        const good = names.every(n => wInfo[n].animated && wInfo[n].lossless && wInfo[n].loop === 0);

        if (good) add('ok', '.webp animate, senza perdita (lossless), ripetizione infinita');
        else add('bad', '.webp non conformi', names.map(n => `${n}: ${wInfo[n].animated ? 'animata' : 'NON animata'}, ${wInfo[n].lossless ? 'lossless' : 'CON perdita'}, loop ${wInfo[n].loop}`).join(' · '));
    }

    // 8. .webm: VP9
    {
        const good = names.every(n => mInfo[n].codec === 'V_VP9');

        if (good) add('ok', `.webm in VP9 con trasparenza (yuva420p), grandezza ×${box.scale}`);
        else add('bad', '.webm non VP9');
    }

    // 9. tempi
    {
        const sum = (a) => a.reduce((x, y) => x + y, 0);

        const rows = names.map(n => ({
            n,
            want: sum(out[n].frames.map(f => f.ms)),
            webp: sum(wInfo[n].durations),
            webm: Math.round(mInfo[n].durationMs)
        }));

        const ok = rows.every(r => r.want === r.webp && r.want === r.webm);

        const txt = rows.map(r => `${r.n}: originale ${r.want} ms · .webp ${r.webp} ms · .webm ${r.webm} ms`).join(' · ');

        if (ok) add('ok', 'Tempi originali: durata uguale nei .webp, nei .webm e nell\'animazione del file', txt + ' · un solo giro, ripetuto all\'infinito');
        else add('bad', 'Le durate non coincidono', txt);
    }

    // 10. stessa grandezza del personaggio in .webm e .webp
    if (mOk) {

        let worst = 0;

        for (const n of names) {

            const bw = siteContentBox(firstOf(wDec, n, fallback), 8);
            const bm = siteContentBox(mDec[n], 8);

            if (bw && bm) worst = Math.max(worst, Math.abs(bw.w - bm.w), Math.abs(bw.h - bm.h));
        }

        if (worst <= 1) add('ok', 'Il personaggio ha la stessa grandezza in pixel nel .webm e nella .webp', `differenza massima ${worst} px (misurati sui pixel con alfa > 8, uguale in entrambi)`);
        else add('warn', `Il personaggio nel .webm differisce di ${worst} px dalla .webp`);
    }

    if (decodeNote) add('warn', 'Alcuni file non si sono riletti nel browser', decodeNote.trim());

    return checks;
}

function siteReportHtml({ checks, box, out, names, where, base, blocked, saveFailed = [] }) {

    const icons = { ok: '✔', warn: '⚠', bad: '✖' };

    const bad = checks.filter(c => c.level === 'bad').length;
    const warn = checks.filter(c => c.level === 'warn').length;

    const failBox = saveFailed.length
        ? `<div class="site-check bad"><span class="ic">✖</span><div><b>Il browser non ha potuto scrivere ${saveFailed.length} file nella cartella.</b><small>${esc(where)}</small>${saveFailed.map(x => `<small>${esc(x.name)} → ${esc(x.reason)}</small>`).join('')}<small>Succede quando la cartella è sincronizzata (OneDrive, Dropbox, Drive), controllata da un antivirus, o il file è aperto altrove: prova una cartella normale (es. Desktop) e poi copia i file.</small></div></div>`
        : '';

    const head = failBox || (blocked
        ? `<div class="site-check bad"><span class="ic">✖</span><div><b>NON salvato: un controllo obbligatorio è fallito.</b><small>Non ho scritto nessun file, per non mettere sul sito file sbagliati.</small></div></div>`
        : (bad || warn
            ? `<div class="site-check warn"><span class="ic">⚠</span><div><b>Salvati i 6 file, ma guarda gli avvisi.</b><small>${esc(where)}</small></div></div>`
            : `<div class="site-check ok"><span class="ic">✔</span><div><b>Fatto: tutti i controlli sono a posto.</b><small>${esc(where)}</small></div></div>`));

    const rows = [];

    for (const n of names) {

        const o = out[n];

        const wi = inspectWebp(o.webpBytes);
        const mi = inspectWebm(o.webmBytes);

        const mem = wi.width * wi.height * wi.frames * 4;

        rows.push(`<tr><td>${esc(base)}-${n}.webm</td><td>${mi.width}×${mi.height}</td><td>${mi.frames}</td><td>${Math.round(mi.durationMs)} ms</td><td>${kbText(o.webmBytes.length)}</td><td>—</td></tr>`);
        rows.push(`<tr><td>${esc(base)}-${n}.webp</td><td>${wi.width}×${wi.height}</td><td>${wi.frames}</td><td>${wi.durations.reduce((a, b) => a + b, 0)} ms</td><td>${kbText(o.webpBytes.length)}</td><td>${(mem / 1e6).toFixed(1)} MB</td></tr>`);
    }

    return `${head}
        <h4>Controlli</h4>
        ${checks.map(c => `<div class="site-check ${c.level}"><span class="ic">${icons[c.level]}</span><div>${esc(c.title)}${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</div></div>`).join('')}
        <h4>Tela comune e file</h4>
        <div style="margin-bottom:6px">Rettangolo comune: <b>${box.w}×${box.h} px</b> (origine ${Math.round(box.rx * 1000) / 1000}, ${Math.round(box.ry * 1000) / 1000} nelle coordinate dell'animatore) = contenuto di tutti i fotogrammi ${box.contentW}×${box.contentH} px + ${SITE_MARGIN} px di margine${(box.w - box.contentW) !== 2 * SITE_MARGIN || (box.h - box.contentH) !== 2 * SITE_MARGIN ? ' (un pixel in più a destra / in basso se la misura era dispari, per il video)' : ''}. Grandezza <b>×${box.scale}</b>${box.scale === 1 ? ' (1:1 con i dati dell\'animatore)' : ' (ingrandimento intero, pixel netti, nessuna sfocatura)'}, sfondo trasparente, ${box.frames} fotogrammi diversi misurati.</div>
        <table class="site-table"><thead><tr><th>File</th><th>Tela</th><th>Fotogrammi</th><th>Durata</th><th>Peso</th><th>Memoria iPhone</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// scrive un file nella cartella scelta; se il browser rifiuta ("il file e' cambiato mentre lo scrivevo":
// capita con cartelle sincronizzate, antivirus, file aperti altrove) riprova con calma, poi cancellando il vecchio
async function siteWriteOne(dir, name, blob) {

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    let last = null;

    for (let attempt = 0; attempt < 4; attempt++) {

        let w = null;

        try {

            if (attempt >= 2) {

                try { await dir.removeEntry(name); } catch (e) { /* non c'era */ }
            }

            const h = await dir.getFileHandle(name, { create: true });

            w = await h.createWritable();

            await w.write(blob);

            await w.close();

            return;

        } catch (e) {

            last = e;

            try { if (w) await w.abort(); } catch (e2) { /* gia' chiuso */ }

            await wait(350 * (attempt + 1));
        }
    }

    throw last;
}

// ZIP con i file (anche quando la cartella non funziona)
async function siteSaveZip(files, zipName) {

    const zip = createZipWriter();

    for (const f of files) zip.addFile(f.name, new Uint8Array(await f.blob.arrayBuffer()));

    await saveFile(zip.finish(), zipName, 'ZIP con i 6 file', 'application/zip', '.zip');
}

// ritorna { text, failed: [{ name, reason }] }
async function siteSaveFiles(files, dirHandle, zipName) {

    if (dirHandle) {

        const failed = [];

        for (const f of files) {

            try {

                await siteWriteOne(dirHandle, f.name, f.blob);

            } catch (e) {

                console.error('Scrittura non riuscita:', f.name, e);

                failed.push({ name: f.name, reason: `${e && e.name ? e.name : 'errore'}: ${e && e.message ? e.message : e}` });
            }
        }

        if (!failed.length) {

            return { text: `Salvati nella cartella «${dirHandle.name}» (se c'erano file con lo stesso nome sono stati sostituiti).`, failed };
        }

        // la cartella non ha accettato qualche file: nessun lavoro perso, si scarica uno ZIP con tutti e 6
        let zipped = true;

        try { await siteSaveZip(files, zipName); } catch (e) { zipped = false; console.error('ZIP non riuscito:', e); }

        return {
            text: `${files.length - failed.length} file su ${files.length} scritti nella cartella «${dirHandle.name}»; non scritti: ${failed.map(x => x.name).join(', ')}. `
                + (zipped ? `Ho scaricato uno ZIP (${zipName}) con tutti e 6 i file: scompattalo nella cartella dell'unità.` : 'Anche lo ZIP non è riuscito.'),
            failed
        };
    }

    await siteSaveZip(files, zipName);

    return { text: `Questo browser non può scrivere in una cartella: scaricato uno ZIP (${zipName}) con i 6 file, da scompattare nella cartella dell'unità.`, failed: [] };
}

async function runSiteExport(pre, picking) {

    const base = siteFileBase();

    const exportBtns = [btnGif, btnApng, btnZip, btnVideo, btnWebp, btnSite];

    const label = btnSite.innerText;

    const onStatus = (t) => { btnSite.innerText = t; };

    exportBtns.forEach(b => b.disabled = true);

    try {

        // la cartella: si sceglie subito (il browser la permette solo subito dopo il clic)
        let dirHandle = null;

        if (picking) {

            try {

                dirHandle = await picking;

            } catch (e) {

                if (e && e.name === 'AbortError') return;

                console.warn('Cartella non disponibile, scarico uno ZIP:', e);
            }
        }

        const names = ['default', 'idle', 'atk'];

        const seqs = pre.seqs;

        onStatus('Preparo i fotogrammi…');

        const lists = {};

        for (const n of names) lists[n] = siteKeyFrames(seqs[n]);

        onStatus('Misuro la tela comune…');

        const box = await measureSiteBox(names.map(n => lists[n]), names.map(n => seqs[n]), (i, n) => onStatus(`Misuro la tela comune… ${Math.round(i / n * 100)}%`), siteEls.scale.value);

        if (Math.max(box.w, box.h) > 8192) throw new Error(`La tela comune è enorme (${box.w}×${box.h} px): controlla l'unità.`);

        const out = {};

        for (const n of names) {

            const frames = lists[n];

            const durations = frames.map(f => f.ms);

            const render = (i, cv) => { siteRenderFrame(frames[i].pieces, box, cv); };

            const w = await encodeAnimatedWebp({
                width: box.w,
                height: box.h,
                count: frames.length,
                durations,
                render,
                hasAlpha: true,
                quality: 1,
                subRect: true,
                loop: 0,
                onProgress: async (i, c) => { onStatus(`${n}: WebP ${i}/${c}`); if (i % 3 === 0) await pause0(); }
            });

            const m = await encodeWebmAlpha({
                width: box.w,
                height: box.h,
                count: frames.length,
                durations,
                render,
                onProgress: async (i, c) => { onStatus(`${n}: WebM ${i}/${c}`); if (i % 3 === 0) await pause0(); }
            });

            out[n] = {
                frames,
                webpBlob: w.blob,
                webpBytes: new Uint8Array(await w.blob.arrayBuffer()),
                webmBlob: m.blob,
                webmBytes: new Uint8Array(await m.blob.arrayBuffer())
            };
        }

        onStatus('Controllo i file…');

        const checks = await siteVerify(box, out, names);

        const blocked = checks.some(c => c.level === 'bad');

        let where = 'Nessun file scritto.';

        let saveFailed = [];

        if (!blocked) {

            onStatus('Salvo i file…');

            const files = [];

            for (const n of names) {

                files.push({ name: `${base}-${n}.webm`, blob: out[n].webmBlob });
                files.push({ name: `${base}-${n}.webp`, blob: out[n].webpBlob });
            }

            const saved = await siteSaveFiles(files, dirHandle, `${base}-sito.zip`);

            where = saved.text;
            saveFailed = saved.failed;
        }

        siteEls.title.textContent = `🌐 Esporta per il sito: ${base}`;

        siteEls.report.innerHTML = siteReportHtml({ checks, box, out, names, where, base, blocked, saveFailed });

        siteEls.overlay.style.display = 'flex';

        siteEls.info.textContent = `Ultima esportazione: ${box.w}×${box.h} px (×${box.scale}) · ${blocked ? 'NON salvato' : (saveFailed.length ? `${saveFailed.length} file non scritti in cartella (scaricato lo ZIP)` : (checks.some(c => c.level !== 'ok') ? 'salvato con avvisi' : 'tutti i controlli ok'))}`;

        state.siteLast = { box, checks, where };

    } catch (error) {

        console.error('Errore esportazione per il sito:', error);

        alert('Errore durante l\'esportazione per il sito: ' + (error && error.message ? error.message : error));

    } finally {

        exportBtns.forEach(b => b.disabled = false);

        btnSite.innerText = label;
    }
}

btnSite.onclick = () => {

    const pre = siteCheckReady();

    if (pre.error) {

        alert(pre.error);

        return;
    }

    // la finestra «scegli la cartella» va aperta subito, dentro il clic
    const picking = window.showDirectoryPicker
        ? window.showDirectoryPicker({ id: 'bf-site-export', mode: 'readwrite' })
        : null;

    runSiteExport(pre, picking);
};