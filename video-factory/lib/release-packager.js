const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { sha256 } = require("./archive-manager");
const { ensureDir, nowIso, writeJsonAtomic } = require("./util");

function copyFile(source, destination) {
    if (!source || !fs.existsSync(source)) return null;
    ensureDir(path.dirname(destination));
    fs.copyFileSync(source, destination);
    return destination;
}

function walk(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const item = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(item) : [item];
    });
}

function copyDirectory(source, destination) {
    if (!fs.existsSync(source)) return;
    fs.cpSync(source, destination, { recursive: true, force: true });
}

function rebasePremiereProject(source, destination, oldRoot, newRoot) {
    const xml = zlib.gunzipSync(fs.readFileSync(source)).toString("utf8");
    const rebased = xml.replaceAll(oldRoot, newRoot);
    if (rebased === xml) {
        throw new Error(`Premiere project does not reference expected workspace: ${oldRoot}`);
    }
    ensureDir(path.dirname(destination));
    fs.writeFileSync(destination, zlib.gzipSync(Buffer.from(rebased, "utf8")));
}

async function createManifest(directory, board, decision, packageRoot) {
    const files = walk(directory).filter((file) => path.basename(file) !== "release-manifest.json");
    const manifestFiles = [];
    for (const file of files) {
        manifestFiles.push({
            relativePath: path.relative(directory, file),
            bytes: fs.statSync(file).size,
            sha256: await sha256(file),
        });
    }
    return {
        schemaVersion: 1,
        createdAt: nowIso(),
        boardId: board.id,
        releaseStatus: decision.status,
        winningRevision: decision.winner.revision,
        packageRoot,
        files: manifestFiles,
    };
}

class ReleasePackager {
    async package(board, winnerJob, decision, artifacts) {
        const releaseDir = path.join(board.workspace, "release");
        ensureDir(releaseDir);
        copyFile(winnerJob.result.render.outputFile, path.join(releaseDir, "final.mp4"));
        rebasePremiereProject(
            winnerJob.result.projectPath,
            path.join(releaseDir, "final.prproj"),
            winnerJob.workspace,
            releaseDir
        );
        copyFile(winnerJob.outputPaths.combinedCaptions, path.join(releaseDir, "captions.srt"));
        copyFile(winnerJob.outputPaths.assetRegistry, path.join(releaseDir, "asset-license-manifest.json"));
        copyFile(winnerJob.outputPaths.editManifest, path.join(releaseDir, "timeline-events.json"));
        copyFile(artifacts.trendReport, path.join(releaseDir, "trend-evidence.json"));
        copyFile(artifacts.performanceMemory, path.join(releaseDir, "lessons.json"));
        copyFile(artifacts.contentBrief, path.join(releaseDir, "content-brief.json"));
        copyFile(artifacts.scorecards, path.join(releaseDir, "judge-scorecards.json"));
        copyFile(artifacts.revisionHistory, path.join(releaseDir, "revision-history.json"));
        copyFile(artifacts.qaReport, path.join(releaseDir, "qa-report.json"));
        writeJsonAtomic(path.join(releaseDir, "release-decision.json"), decision);

        copyDirectory(
            path.join(winnerJob.workspace, "generated-assets"),
            path.join(releaseDir, "generated-assets")
        );
        copyDirectory(
            path.join(winnerJob.workspace, "source-assets"),
            path.join(releaseDir, "source-assets")
        );
        copyDirectory(
            path.join(winnerJob.workspace, "transcripts"),
            path.join(releaseDir, "transcripts")
        );
        const captionAssets = path.join(winnerJob.workspace, "generated-assets", "captions");
        if (fs.existsSync(captionAssets)) {
            fs.cpSync(captionAssets, path.join(releaseDir, "animated-captions"), { recursive: true, force: true });
        }
        const manifest = await createManifest(releaseDir, board, decision, releaseDir);
        writeJsonAtomic(path.join(releaseDir, "release-manifest.json"), manifest);

        let archiveDirectory = null;
        if (board.archive.enabled) {
            archiveDirectory = path.join(board.archive.destinationRoot, board.campaignId, board.id);
            if (fs.existsSync(archiveDirectory)) {
                throw new Error(`Board archive already exists: ${archiveDirectory}`);
            }
            ensureDir(path.dirname(archiveDirectory));
            const temporary = `${archiveDirectory}.partial-${process.pid}`;
            fs.cpSync(releaseDir, temporary, { recursive: true, errorOnExist: true });
            for (const entry of manifest.files) {
                const archived = path.join(temporary, entry.relativePath);
                if (!fs.existsSync(archived) || await sha256(archived) !== entry.sha256) {
                    throw new Error(`Board archive verification failed: ${entry.relativePath}`);
                }
            }
            rebasePremiereProject(
                path.join(temporary, "final.prproj"),
                path.join(temporary, "final.prproj"),
                releaseDir,
                archiveDirectory
            );
            const archiveManifest = await createManifest(temporary, board, decision, archiveDirectory);
            writeJsonAtomic(path.join(temporary, "release-manifest.json"), archiveManifest);
            for (const entry of archiveManifest.files) {
                const archived = path.join(temporary, entry.relativePath);
                if (!fs.existsSync(archived) || await sha256(archived) !== entry.sha256) {
                    throw new Error(`Rebased board archive verification failed: ${entry.relativePath}`);
                }
            }
            fs.renameSync(temporary, archiveDirectory);
        }
        return {
            releaseDirectory: releaseDir,
            archiveDirectory,
            finalVideo: path.join(releaseDir, "final.mp4"),
            finalProject: path.join(releaseDir, "final.prproj"),
            manifest: path.join(releaseDir, "release-manifest.json"),
        };
    }
}

module.exports = { ReleasePackager, createManifest, rebasePremiereProject };
