export const Parser = {

    parseCGG(text) {

        const framesDB = [];

        const lines =
            text.split(/\r?\n/);


        for (const line of lines) {

            if (!line.trim()) {
                continue;
            }


            const values =
                line
                    .split(",")
                    .map(value => value.trim())
                    .filter(value => value !== "")
                    .map(Number);


            if (values.length < 2) {
                continue;
            }


            const frameId =
                values[0];


            const numPieces =
                values[1];


            const pieces = [];


            for (
                let i = 0;
                i < numPieces;
                i++
            ) {

                const base =
                    2 + (i * 11);


                if (
                    base + 10 >=
                    values.length
                ) {
                    console.warn(
                        "CGG: pezzo incompleto",
                        frameId,
                        i
                    );

                    continue;
                }


                const piece = {

                    x: values[base + 0],

                    y: values[base + 1],

                    flipType:
                        values[base + 2],

                    blendMode:
                        values[base + 3],

                    opacity:
                        values[base + 4],

                    rotate:
                        values[base + 5],

                    sx:
                        values[base + 6],

                    sy:
                        values[base + 7],

                    w:
                        values[base + 8],

                    h:
                        values[base + 9],

                    pageId:
                        values[base + 10]
                };


                pieces.push(piece);
            }


            /*
                IMPORTANTE:

                L'ID del frame CGG è normalmente l'indice
                della riga nel database dei frame.

                Manteniamo quindi l'ordine originale.
            */

            framesDB.push(pieces);
        }


        return framesDB;
    },


    // =========================================================
    // CGS
    // =========================================================

    parseCGS(text) {

        const frames = [];

        const lines =
            text.split(/\r?\n/);


        for (const line of lines) {

            if (!line.trim()) {
                continue;
            }


            const parts =
                line
                    .split(",")
                    .map(value =>
                        Number(value.trim())
                    );


            frames.push({

                id:
                    Number.isFinite(parts[0])
                        ? parts[0]
                        : 0,

                xOffset:
                    Number.isFinite(parts[1])
                        ? parts[1]
                        : 0,

                yOffset:
                    Number.isFinite(parts[2])
                        ? parts[2]
                        : 0,

                duration:
                    Number.isFinite(parts[3])
                        ? parts[3]
                        : 1
            });
        }


        return frames;
    }
};