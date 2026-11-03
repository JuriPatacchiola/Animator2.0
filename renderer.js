export const Renderer = {

    canvas: null,
    ctx: null,

    image: null,

    scale: 0.2,

    offsetX: 0,
    offsetY: 0,

    // pixel reali per pixel CSS (schermi con scala 125%, 150%, ...)
    dpr: 1,

    // chiamata dopo ogni ridimensionamento (il canvas si svuota da solo)
    onResize: null,


    // =========================================================
    // INIT
    // =========================================================

    init(canvasId) {

        this.canvas = document.getElementById(canvasId);

        if (!this.canvas) {

            console.error(
                "Renderer: Canvas non trovato!"
            );

            return;
        }

        this.ctx = this.canvas.getContext('2d');

        this.resize();

        window.addEventListener(
            'resize',
            () => this.resize()
        );
    },


    // =========================================================
    // RESIZE
    // =========================================================

    resize() {

        if (!this.canvas) {
            return;
        }

        const parent = this.canvas.parentElement;

        if (!parent) {
            return;
        }

        /*
            Il canvas deve avere ESATTAMENTE i pixel con cui viene mostrato.

            Prima la dimensione era quella del contenitore compreso il
            padding (20 px per lato): il CSS (max-width / max-height: 100%)
            lo rimpiccioliva di circa il 4-6% e, con
            "image-rendering: pixelated", il browser buttava via una
            colonna e una riga di pixel ogni tanto. Muovendosi, i pezzi
            sembravano saltare di un pixel: e' uno degli scatti.
        */

        const css = getComputedStyle(parent);

        const cssWidth =
            parent.clientWidth -
            parseFloat(css.paddingLeft) -
            parseFloat(css.paddingRight);

        const cssHeight =
            parent.clientHeight -
            parseFloat(css.paddingTop) -
            parseFloat(css.paddingBottom);

        this.dpr = window.devicePixelRatio || 1;

        this.canvas.style.width = Math.max(1, Math.floor(cssWidth)) + 'px';
        this.canvas.style.height = Math.max(1, Math.floor(cssHeight)) + 'px';

        this.canvas.width = Math.max(1, Math.round(Math.floor(cssWidth) * this.dpr));
        this.canvas.height = Math.max(1, Math.round(Math.floor(cssHeight) * this.dpr));

        if (this.onResize) {
            this.onResize();
        }
    },


    // =========================================================
    // LOAD IMAGE
    // =========================================================

    loadImage(file) {

        return new Promise((resolve, reject) => {

            if (!file) {

                reject(
                    new Error("File immagine non valido.")
                );

                return;
            }

            const img = new Image();

            img.onload = () => {

                this.image = img;

                resolve();
            };

            img.onerror = () => {

                reject(
                    new Error(
                        "Errore caricamento immagine."
                    )
                );
            };

            img.src = URL.createObjectURL(file);
        });
    },


    // =========================================================
    // DRAW (sullo schermo, con zoom e pan)
    // =========================================================

    draw(
        pieces,
        cgsFrame = {
            xOffset: 0,
            yOffset: 0
        }
    ) {

        if (!this.ctx || !this.canvas) {
            return;
        }


        this.ctx.clearRect(
            0,
            0,
            this.canvas.width,
            this.canvas.height
        );


        if (!this.image || !pieces) {
            return;
        }


        this.ctx.save();


        const centerX =
            this.canvas.width / 2;

        const centerY =
            this.canvas.height / 2;


        this.ctx.translate(
            centerX + this.offsetX * this.dpr,
            centerY + this.offsetY * this.dpr
        );

        // lo zoom e' in pixel CSS: moltiplico per i pixel reali dello schermo
        this.ctx.scale(
            this.scale * this.dpr,
            this.scale * this.dpr
        );


        /*
            Pixel art ingrandita (zoom >= 1): nessuna interpolazione,
            pixel netti.

            Rimpicciolita (zoom < 1): con "nearest" i pezzi che si
            muovono di frazioni di pixel saltano di un pixel intero
            alla volta e tremolano. Qui serve l'interpolazione.
        */

        this.ctx.imageSmoothingEnabled =
            this.scale * this.dpr < 1;

        this.ctx.imageSmoothingQuality =
            'high';


        this.drawPieces(
            this.ctx,
            pieces,
            Number(cgsFrame.xOffset) || 0,
            Number(cgsFrame.yOffset) || 0
        );


        this.ctx.restore();
    },


    // =========================================================
    // DISEGNO DEI PEZZI SU UN CONTESTO QUALSIASI
    // (usato sia dallo schermo sia dall'esportazione GIF)
    // =========================================================

    drawPieces(
        ctx,
        pieces,
        frameOffsetX = 0,
        frameOffsetY = 0
    ) {

        if (!this.image || !pieces) {
            return;
        }


        /*
            I pezzi vengono disegnati dal fondo verso
            il primo piano.
        */

        for (
            let i = pieces.length - 1;
            i >= 0;
            i--
        ) {

            const piece = pieces[i];

            if (!piece) {
                continue;
            }

            if (
                piece.w <= 0 ||
                piece.h <= 0
            ) {
                continue;
            }


            ctx.save();


            // -------------------------------------------------
            // OPACITÀ
            // -------------------------------------------------

            const opacity =
                Number.isFinite(piece.opacity)
                    ? piece.opacity
                    : 100;

            ctx.globalAlpha =
                Math.max(
                    0,
                    Math.min(
                        1,
                        opacity / 100
                    )
                );


            // -------------------------------------------------
            // BLEND MODE
            // -------------------------------------------------

            if (piece.blendMode === 1) {

                ctx.globalCompositeOperation =
                    'lighter';

            } else {

                ctx.globalCompositeOperation =
                    'source-over';
            }


            // -------------------------------------------------
            // POSIZIONE DEL PEZZO
            // -------------------------------------------------

            const x =
                (Number(piece.x) || 0) +
                frameOffsetX;

            const y =
                (Number(piece.y) || 0) +
                frameOffsetY;


            /*
                Il pezzo viene posizionato usando il suo
                centro come pivot: flip e rotazione avvengono
                attorno allo stesso punto.
            */

            const pivotX =
                x + (piece.w / 2);

            const pivotY =
                y + (piece.h / 2);


            ctx.translate(
                pivotX,
                pivotY
            );


            // =================================================
            // FLIP
            // =================================================

            const flipType =
                Number(piece.flipType) || 0;

            const scaleX =
                (flipType === 1 || flipType === 3) ? -1 : 1;

            const scaleY =
                (flipType === 2 || flipType === 3) ? -1 : 1;


            ctx.scale(
                scaleX,
                scaleY
            );


            // =================================================
            // ROTAZIONE (segno negativo, come nel tuo CGG)
            // =================================================

            const rotation =
                Number(piece.rotate) || 0;


            if (rotation !== 0) {

                ctx.rotate(
                    -rotation * Math.PI / 180
                );
            }


            // =================================================
            // DRAW IMAGE
            // =================================================

            ctx.drawImage(

                this.image,

                // SORGENTE SPRITESHEET
                piece.sx,
                piece.sy,
                piece.w,
                piece.h,

                // DESTINAZIONE
                -piece.w / 2,
                -piece.h / 2,
                piece.w,
                piece.h
            );


            ctx.restore();
        }
    },


    // =========================================================
    // IMMAGINE INTERA DI UN FRAME (per GIF)
    //
    // box = area fissa che contiene tutta l'animazione {x,y,w,h}:
    // e' uguale per tutti i frame, quindi non c'e' nessuno
    // "spostamento" dovuto al ritaglio.
    // bg = "#rrggbb" oppure null per lo sfondo trasparente.
    // =========================================================

    renderToCanvas(
        pieces,
        box,
        scale = 1,
        bg = null,
        target = null
    ) {

        const width =
            Math.max(1, Math.round(box.w * scale));

        const height =
            Math.max(1, Math.round(box.h * scale));


        const canvas =
            target || document.createElement('canvas');

        canvas.width = width;
        canvas.height = height;


        const ctx =
            canvas.getContext(
                '2d',
                { willReadFrequently: true }
            );


        ctx.clearRect(0, 0, width, height);


        if (bg) {

            ctx.fillStyle = bg;

            ctx.fillRect(0, 0, width, height);
        }


        ctx.save();

        ctx.scale(scale, scale);

        ctx.translate(-box.x, -box.y);

        // pixel netti: nell'esportazione non voglio sfocature
        // ingrandito: pixel netti; rimpicciolito: serve l'interpolazione
        ctx.imageSmoothingEnabled = scale < 1;

        ctx.imageSmoothingQuality = 'high';

        this.drawPieces(ctx, pieces, 0, 0);

        ctx.restore();


        return canvas;
    }
};