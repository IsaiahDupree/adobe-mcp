const fs = require("fs");
const path = require("path");
const { ensureDir, run } = require("./util");

function captionLayout(width, height) {
    return {
        safeWidth: Math.floor(width * 0.82),
        safeHeight: Math.floor(height * 0.2),
        bottomInset: Math.floor(height * 0.09),
        pointSize: Math.max(30, Math.min(46, Math.round(height * 0.055))),
    };
}

class CaptionRenderer {
    constructor(config) {
        this.magickBin = config.IMAGEMAGICK_BIN;
        this.font = config.CAPTION_FONT;
    }

    async render(job, plan) {
        const directory = path.join(job.workspace, "generated-assets", "captions");
        ensureDir(directory);
        const isLandscape = job.generation.aspectRatio === "16:9";
        const width = Number(job.generation.width || (isLandscape ? 1280 : 720));
        const height = Number(job.generation.height || (isLandscape ? 720 : 1280));
        const layout = captionLayout(width, height);
        const assets = [];

        for (let index = 0; index < plan.captions.length; index += 1) {
            const cue = plan.captions[index];
            const output = path.join(
                directory,
                `caption-bold-white-${String(index + 1).padStart(3, "0")}.png`
            );
            const textLayer = path.join(directory, `.caption-${String(index + 1).padStart(3, "0")}.png`);
            await run(
                this.magickBin,
                [
                    "-background",
                    "none",
                    "-fill",
                    "white",
                    "-stroke",
                    "#101010",
                    "-strokewidth",
                    "2",
                    "-font",
                    this.font,
                    "-pointsize",
                    String(layout.pointSize),
                    "-interline-spacing",
                    "4",
                    "-gravity",
                    "center",
                    "-size",
                    `${layout.safeWidth}x${layout.safeHeight}`,
                    `caption:${cue.text.toUpperCase()}`,
                    "-trim",
                    "+repage",
                    textLayer,
                ],
                { timeout: 30000 }
            );
            const dimensions = await run(
                this.magickBin,
                ["identify", "-format", "%w %h", textLayer],
                { timeout: 30000 }
            );
            const [textWidth, textHeight] = dimensions.stdout.trim().split(/\s+/).map(Number);
            if (textWidth > layout.safeWidth || textHeight > layout.safeHeight) {
                throw new Error(`Caption ${index + 1} exceeds the safe text area (${textWidth}x${textHeight}).`);
            }
            await run(
                this.magickBin,
                [
                    "-size",
                    `${width}x${height}`,
                    "xc:none",
                    textLayer,
                    "-gravity",
                    "south",
                    "-geometry",
                    `+0+${layout.bottomInset}`,
                    "-composite",
                    output,
                ],
                { timeout: 30000 }
            );
            fs.unlinkSync(textLayer);
            assets.push({
                index,
                text: cue.text,
                start: cue.start,
                end: cue.end,
                path: output,
                textBounds: { width: textWidth, height: textHeight },
                safeArea: { width: layout.safeWidth, height: layout.safeHeight },
            });
        }
        return assets;
    }
}

module.exports = { CaptionRenderer, captionLayout };
