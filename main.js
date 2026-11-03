import { createAPNGWriter, createZipWriter } from './apng.js';
import { initAssembler } from './assembler.js';
import { createGifWriter, createPaletteBuilder } from './gif.js';
import { Parser } from './parser.js';
import { Renderer } from './renderer.js';
import { buildSamUnit, reduceSamSequence } from './sam.js';
import {
    TICK_MS,
    composeFrame,
    computeGroundShifts,
    frameDuration,
    sampleSequence,
    sequenceBounds,
    sequenceTotalTicks,
    setSamSoft
} from './smoothing.js';


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

    // .sam: sequenze complete del file e nomi mostrati (state.sequences ha quelle ridotte ai frame principali)
    samFull: {},
    samLabels: {},

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

    return state.current === 'all' ? 'completa' : state.current;
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

        chkSmooth.blur();

        renderCurrentFrame();
    }
);


chkLock.addEventListener(
    'change',
    () => {

        state.lock = chkLock.checked;

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

    // unita' .sam: si disegna cosi' com'e'
    if (state.samMode) {

        state.framesDB = state.framesDBOrig;

        return;
    }

    state.framesDB = chkAutoShadow.checked
        ? withMissingShadows(state.framesDBOrig)
        : state.framesDBOrig;
}

chkAutoShadow.addEventListener(
    'change',
    () => {

        applyAutoShadow();

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
    () => {

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

function loadMany(fileList) {

    const files = [...fileList];

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

        // niente ombra da cui ricavare il blocco a terra
        state.shifts = unit.framesDB.map(() => ({ x: 0, y: 0 }));

        setSamMode(unit);

        rebuildAll();

        const notes = [];

        if (sams.length > 1) notes.push(`⚠ Carico solo il primo .sam, ignorati: ${sams.slice(1).map(f => f.name).join(', ')}`);

        if (unit.missing.length) notes.push(`⚠ Mancano ${unit.missing.length} PNG su ${unit.spriteCount} (es. ${unit.missing[0]}): quei pezzi non si vedono. Aggiungi la cartella che li contiene.`);

        if (unit.warnings.length) notes.push(`⚠ ${unit.warnings.length} frame del .sam non decodificati (es. ${unit.warnings[0]})`);

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

// passaggio tra i disegni di due pose (scelta salvata nel browser)
const SAM_SOFT_KEY = 'animator.samSoft';

try {

    const saved = localStorage.getItem(SAM_SOFT_KEY);

    if (saved !== null && [...samEls.soft.options].some(o => o.value === saved)) samEls.soft.value = saved;

} catch (e) { /* ignoro */ }

setSamSoft(samEls.soft.value);

samEls.soft.addEventListener('change', () => {

    setSamSoft(samEls.soft.value);

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

    // sono opzioni dei file CGG (ombra)
    chkAutoShadow.disabled = false;
    chkLock.disabled = false;

    // i CGS contano sempre 1/60 di secondo per tick
    state.tickMs = TICK_MS;
    samSpeedBox.style.display = 'none';
}

function setSamMode(unit) {

    state.samMode = true;

    state.animNames = unit.order;

    state.samFull = unit.sequences;
    state.samLabels = unit.labels;

    // frame principali (scelta salvata nel browser)
    try {

        const saved = localStorage.getItem(SAM_REDUCE_KEY);

        if (saved !== null && [...samEls.reduce.options].some(o => o.value === saved)) samEls.reduce.value = saved;

    } catch (e) { /* ignoro */ }

    applySamReduce();

    // niente CGG: l'ombra aggiunta e il blocco a terra non c'entrano
    chkAutoShadow.disabled = true;
    chkLock.disabled = true;

    // velocita' scelta per i .sam (salvata nel browser)
    state.tickMs = readSamTick();
    samEls.num.value = round1(state.tickMs);
    samEls.range.value = state.tickMs;
    samSpeedBox.style.display = 'flex';
    updateSamDuration();

    if (state.current !== 'all' && !state.sequences[state.current]) state.current = unit.order[0];

    selectAnim.value = state.current;

    updateSamDuration();
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

    samEls.reduceInfo.textContent = tol
        ? 'Frame: ' + parts.join(' · ')
        : 'Tutti i frame del file (' + parts.join(' · ') + ')';

    // senza i passaggi intermedi servono i frame creati dal "Morbido": anteprima ed esportazione
    if (tol) {

        chkSmooth.checked = true;
        state.smooth = true;

        document.getElementById('exportSmooth').checked = true;
    }

    updateSamDuration();
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
            autoShadow: chkAutoShadow.checked
        }));

    } catch (e) { /* ignoro */ }
}

['gifScale', 'gifFps', 'exportSmooth', 'gifLimit', 'gifLimitMp'].forEach(id => document.getElementById(id).addEventListener('change', () => {

    saveExportPrefs();

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

function exportBox(shifts) {

    if (areaEls.screen.checked) return screenBox();

    if (document.getElementById('areaFixed').checked) {

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

function exportPlan(scale, maxMp = 0) {

    const sequence = state.sequences[state.current];

    const shifts = activeShifts();

    const box = exportBox(shifts);

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

    return (p) => {

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

    const exportButtons = [btnGif, btnApng, btnZip, btnVideo];

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


// ---- VIDEO WebM (registrato in tempo reale dal canvas) ----
//
// Nessun fotogramma preparato in anticipo: ognuno si disegna nel
// momento in cui va mostrato (e' veloce), quindi la memoria non
// dipende dalla durata.

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

    const cv = document.createElement('canvas');

    cv.width = width;
    cv.height = height;

    const ctx = cv.getContext('2d');

    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

    const mime = types.find(t => MediaRecorder.isTypeSupported(t));

    const stream = cv.captureStream(0);

    const track = stream.getVideoTracks()[0];

    const rec = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 20_000_000
    });

    const chunks = [];

    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const stopped = new Promise(resolve => { rec.onstop = resolve; });

    const loopMs = delays.reduce((a, b) => a + b, 0) * 10;

    // almeno 3 secondi: il video si ripete finche' non li raggiunge
    const loops = Math.max(1, Math.ceil(3000 / loopMs));

    const draw = (k) => {

        Renderer.renderToCanvas(framePieces(plan, k), plan.box, plan.scale, transparent ? null : o.bgFill, work);

        ctx.clearRect(0, 0, width, height);

        ctx.drawImage(work, 0, 0);

        if (track.requestFrame) track.requestFrame();
    };

    rec.start(1000);           // consegna i dati ogni secondo invece che tutti alla fine

    draw(0);

    const t0 = performance.now();

    await new Promise(resolve => {

        let shown = -1;

        const step = () => {

            const el = performance.now() - t0;

            if (el >= loopMs * loops) {
                resolve();
                return;
            }

            // fotogramma corrente in base al tempo trascorso nel loop
            let local = el % loopMs;
            let i = 0;

            while (i < delays.length - 1 && local >= delays[i] * 10) {
                local -= delays[i] * 10;
                i++;
            }

            const key = Math.floor(el / loopMs) * 100000 + i;

            if (key !== shown) {
                shown = key;
                draw(i);
            }

            o.onStatus(`Registro il video… ${Math.round(el / (loopMs * loops) * 100)}%`);

            requestAnimationFrame(step);
        };

        step();
    });

    draw(0);

    await new Promise(r => setTimeout(r, 100));

    rec.stop();

    await stopped;

    await saveFile(
        new Blob(chunks, { type: 'video/webm' }),
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