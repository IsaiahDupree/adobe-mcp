const fs = require("fs");
const path = require("path");
const { ensureDir, run } = require("./util");

class CaptionRenderer {
    constructor(config) {
        this.magickBin = config.IMAGEMAGICK_BIN;
        this.font = config.CAPTION_FONT;
    }

    async render(job, plan) {
        const directory = path.join(job.workspace, "generated-assets", "captions");
        ensureDir(directory);
        const width = Number(job.generation.width || 720);
        const height = Number(job.generation.height || 1280);
        const assets = [];

        for (let index = 0; index < plan.captions.length; index += 1) {
            const cue = plan.captions[index];
            const output = path.join(
                directory,
                `caption-bold-white-${String(index + 1).padStart(3, "0")}.png`
            );
            await run(
                this.magickBin,
                [
                    "-size",
                    `${width}x${height}`,
                    "xc:none",
                    "-gravity",
                    "south",
                    "-font",
                    this.font,
                    "-pointsize",
                    "46",
                    "-fill",
                    "white",
                    "-stroke",
                    "none",
                    "-annotate",
                    "+0+100",
                    cue.text.toUpperCase(),
                    output,
                ],
                { timeout: 30000 }
            );
            assets.push({
                index,
                text: cue.text,
                start: cue.start,
                end: cue.end,
                path: output,
            });
        }
        return assets;
    }
}

module.exports = { CaptionRenderer };
