const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDir, nowIso, writeJsonAtomic } = require("./util");

class ArchiveError extends Error {
    constructor(message, code = "ARCHIVE_FAILED", details = {}) {
        super(message);
        this.name = "ArchiveError";
        this.code = code;
        this.details = details;
    }
}

function isInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walkFiles(directory) {
    if (!fs.existsSync(directory)) return [];
    const output = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) output.push(...walkFiles(entryPath));
        if (entry.isFile()) output.push(entryPath);
    }
    return output;
}

function sha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

class ArchiveManager {
    constructor(config, adapter) {
        this.config = config;
        this.adapter = adapter;
    }

    normalizeOptions(job, overrides = {}) {
        const current = job.archive || {};
        const mode = overrides.mode || current.mode || "copy";
        if (!["copy", "move"].includes(mode)) {
            throw new ArchiveError("Archive mode must be copy or move.", "ARCHIVE_CONFIG_INVALID");
        }
        const destinationRoot = path.normalize(
            overrides.destinationRoot ||
                overrides.destination_root ||
                current.destinationRoot ||
                this.config.PASSPORT_ARCHIVE_ROOT
        );
        if (!path.isAbsolute(destinationRoot)) {
            throw new ArchiveError(
                "Archive destination root must be absolute.",
                "ARCHIVE_CONFIG_INVALID"
            );
        }
        return {
            enabled: true,
            mode,
            destinationRoot,
            includeSourceAssets:
                overrides.includeSourceAssets !== undefined
                    ? Boolean(overrides.includeSourceAssets)
                    : overrides.include_source_assets !== undefined
                      ? Boolean(overrides.include_source_assets)
                      : Boolean(current.includeSourceAssets),
        };
    }

    assertDestinationReady(destinationRoot, requiredBytes) {
        let existingAncestor = destinationRoot;
        while (!fs.existsSync(existingAncestor)) {
            const parent = path.dirname(existingAncestor);
            if (parent === existingAncestor) break;
            existingAncestor = parent;
        }
        if (!fs.existsSync(existingAncestor)) {
            throw new ArchiveError(
                `Archive volume is not mounted for: ${destinationRoot}`,
                "ARCHIVE_VOLUME_MISSING"
            );
        }
        ensureDir(destinationRoot);
        try {
            fs.accessSync(destinationRoot, fs.constants.R_OK | fs.constants.W_OK);
            const probe = path.join(destinationRoot, `.video-factory-write-test-${process.pid}`);
            fs.writeFileSync(probe, nowIso(), { encoding: "utf8", flag: "wx" });
            fs.unlinkSync(probe);
        } catch (error) {
            throw new ArchiveError(
                `Archive destination is not writable: ${destinationRoot}`,
                "ARCHIVE_NOT_WRITABLE",
                { cause: error.message }
            );
        }
        const stats = fs.statfsSync(destinationRoot);
        const availableBytes = Number(stats.bavail) * Number(stats.bsize);
        const minimumHeadroom = 1024 * 1024 * 1024;
        if (availableBytes < requiredBytes + minimumHeadroom) {
            throw new ArchiveError(
                "My Passport does not have enough free space for this archive.",
                "ARCHIVE_INSUFFICIENT_SPACE",
                { requiredBytes, availableBytes, minimumHeadroom }
            );
        }
        return availableBytes;
    }

    collectArtifacts(job, options) {
        const workspaceFolders = [
            "request",
            "research",
            "script",
            "generated-assets",
            "voice",
            "transcripts",
            "edit-plans",
            "premiere",
            "proxies",
            "renders",
            "qc",
            "approved",
            "published",
            "logs",
        ];
        if (options.includeSourceAssets) workspaceFolders.push("source-assets");
        const paths = [];
        for (const folder of workspaceFolders) {
            paths.push(...walkFiles(path.join(job.workspace, folder)));
        }
        for (const outputPath of Object.values(job.outputPaths || {})) {
            if (outputPath && fs.existsSync(outputPath) && fs.statSync(outputPath).isFile()) {
                paths.push(outputPath);
            }
        }
        if (options.includeSourceAssets) {
            for (const asset of job.production.sourceAssets || []) {
                if (fs.existsSync(asset.path) && fs.statSync(asset.path).isFile()) {
                    paths.push(asset.path);
                }
            }
        }

        const seen = new Set();
        return paths
            .map((sourcePath) => path.resolve(sourcePath))
            .filter((sourcePath) => {
                if (seen.has(sourcePath)) return false;
                seen.add(sourcePath);
                return true;
            })
            .map((sourcePath) => ({
                sourcePath,
                relativePath: this.archiveRelativePath(job, sourcePath, options),
                bytes: fs.statSync(sourcePath).size,
            }));
    }

    archiveRelativePath(job, sourcePath, options) {
        if (isInside(job.workspace, sourcePath)) {
            return path.relative(job.workspace, sourcePath);
        }
        if (job.outputPaths.render && path.resolve(job.outputPaths.render) === sourcePath) {
            return path.join("renders", path.basename(sourcePath));
        }
        if (job.outputPaths.project && path.resolve(job.outputPaths.project) === sourcePath) {
            return path.join("premiere", path.basename(sourcePath));
        }
        if (
            options.includeSourceAssets &&
            (job.production.sourceAssets || []).some(
                (asset) => path.resolve(asset.path) === sourcePath
            )
        ) {
            return path.join("source-assets", path.basename(sourcePath));
        }
        return path.join("artifacts", path.basename(sourcePath));
    }

    shouldRemoveLocal(job, entry, options) {
        if (isInside(options.destinationRoot, entry.sourcePath)) return false;
        if (job.outputPaths.project && path.resolve(job.outputPaths.project) === entry.sourcePath) {
            return true;
        }
        if (job.outputPaths.render && path.resolve(job.outputPaths.render) === entry.sourcePath) {
            return true;
        }
        const removableFolders = [
            "generated-assets",
            "voice",
            "premiere",
            "proxies",
            "renders",
            "approved",
            "published",
        ].map((folder) => path.join(job.workspace, folder));
        if (removableFolders.some((folder) => isInside(folder, entry.sourcePath))) return true;
        return Boolean(
            options.includeSourceAssets &&
                (job.production.sourceAssets || []).some(
                    (asset) => path.resolve(asset.path) === entry.sourcePath
                )
        );
    }

    async closeActiveArchivedProject(job) {
        if (!this.adapter) return null;
        if (!job.outputPaths.project || !fs.existsSync(job.outputPaths.project)) return null;
        try {
            const snapshot = await this.adapter.inspectProject();
            if (
                snapshot.project &&
                snapshot.project.hasProject &&
                path.resolve(snapshot.project.path) === path.resolve(job.outputPaths.project)
            ) {
                const packet = await this.adapter.command("closeProject");
                return packet.response || { closed: true };
            }
        } catch (error) {
            throw new ArchiveError(
                `Could not close the active Premiere project before moving it: ${error.message}`,
                "ARCHIVE_PROJECT_CLOSE_FAILED"
            );
        }
        return null;
    }

    async copyAndVerify(entry, archiveDirectory, resumeOwnArchive = false) {
        const destinationPath = path.join(archiveDirectory, entry.relativePath);
        ensureDir(path.dirname(destinationPath));
        const sourceHash = await sha256(entry.sourcePath);
        let reused = false;

        if (fs.existsSync(destinationPath)) {
            const destinationHash = await sha256(destinationPath);
            const destinationBytes = fs.statSync(destinationPath).size;
            if (destinationHash !== sourceHash || destinationBytes !== entry.bytes) {
                if (!resumeOwnArchive) {
                    throw new ArchiveError(
                        `Archive conflict at ${destinationPath}; existing file differs from source.`,
                        "ARCHIVE_CONFLICT",
                        { sourcePath: entry.sourcePath, destinationPath }
                    );
                }
                const supersededPath = `${destinationPath}.superseded-${Date.now()}`;
                fs.renameSync(destinationPath, supersededPath);
            } else {
                reused = true;
            }
        }
        if (!fs.existsSync(destinationPath)) {
            const partialPath = `${destinationPath}.partial-${process.pid}`;
            try {
                await fs.promises.copyFile(
                    entry.sourcePath,
                    partialPath,
                    fs.constants.COPYFILE_EXCL
                );
            } catch (error) {
                try {
                    fs.unlinkSync(partialPath);
                } catch {
                    // The copy may have failed before creating the partial file.
                }
                throw new ArchiveError(
                    `Could not copy ${entry.sourcePath}: ${error.message}`,
                    "ARCHIVE_COPY_FAILED"
                );
            }
            const partialHash = await sha256(partialPath);
            const partialBytes = fs.statSync(partialPath).size;
            if (partialHash !== sourceHash || partialBytes !== entry.bytes) {
                try {
                    fs.unlinkSync(partialPath);
                } catch {
                    // Keep the original source; cleanup can be retried later.
                }
                throw new ArchiveError(
                    `Checksum verification failed while copying ${entry.sourcePath}.`,
                    "ARCHIVE_CHECKSUM_FAILED"
                );
            }
            fs.renameSync(partialPath, destinationPath);
        }

        const destinationHash = await sha256(destinationPath);
        return {
            sourcePath: entry.sourcePath,
            archivePath: destinationPath,
            relativePath: entry.relativePath,
            bytes: entry.bytes,
            sha256: sourceHash,
            checksumMatch: destinationHash === sourceHash,
            reused,
            localRemoved: false,
        };
    }

    async archiveJob(job, overrides = {}) {
        const options = this.normalizeOptions(job, overrides);
        const archiveDirectory = path.join(
            options.destinationRoot,
            job.campaignId,
            job.id
        );
        const manifestPath = path.join(archiveDirectory, "archive-manifest.json");
        let resumeOwnArchive = false;
        if (fs.existsSync(manifestPath)) {
            try {
                const priorManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                resumeOwnArchive = priorManifest.jobId === job.id;
            } catch {
                resumeOwnArchive = false;
            }
        }
        const projectClose =
            options.mode === "move" ? await this.closeActiveArchivedProject(job) : null;
        const entries = this.collectArtifacts(job, options);
        if (entries.length === 0) {
            throw new ArchiveError("No completed job artifacts were found to archive.");
        }
        const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
        const availableBytesBefore = this.assertDestinationReady(
            options.destinationRoot,
            totalBytes
        );
        ensureDir(archiveDirectory);

        const files = [];
        for (const entry of entries) {
            files.push(
                await this.copyAndVerify(entry, archiveDirectory, resumeOwnArchive)
            );
        }
        if (!files.every((file) => file.checksumMatch)) {
            throw new ArchiveError("Archive verification did not pass for every file.");
        }

        const manifest = {
            schemaVersion: 1,
            jobId: job.id,
            campaignId: job.campaignId,
            mode: options.mode,
            createdAt: nowIso(),
            sourceWorkspace: job.workspace,
            archiveDirectory,
            totalFiles: files.length,
            totalBytes,
            availableBytesBefore,
            includeSourceAssets: options.includeSourceAssets,
            verified: true,
            projectClose,
            files,
        };
        writeJsonAtomic(manifestPath, manifest);

        if (options.mode === "move") {
            for (const file of manifest.files) {
                const entry = entries.find((candidate) => candidate.sourcePath === file.sourcePath);
                if (!entry || !this.shouldRemoveLocal(job, entry, options)) continue;
                if (!fs.existsSync(file.sourcePath)) {
                    file.localRemoved = true;
                    continue;
                }
                const currentHash = await sha256(file.sourcePath);
                if (currentHash !== file.sha256) {
                    throw new ArchiveError(
                        `Local file changed after verification; refusing to remove ${file.sourcePath}.`,
                        "ARCHIVE_SOURCE_CHANGED"
                    );
                }
                fs.unlinkSync(file.sourcePath);
                file.localRemoved = true;
            }
            manifest.movedAt = nowIso();
            writeJsonAtomic(manifestPath, manifest);
        }

        const receipt = {
            archivedAt: nowIso(),
            mode: options.mode,
            archiveDirectory,
            manifestPath,
            totalFiles: files.length,
            totalBytes,
            verified: true,
            localFilesRemoved: files.filter((file) => file.localRemoved).length,
            archivedProjectPath:
                files.find(
                    (file) =>
                        job.outputPaths.project &&
                        path.resolve(file.sourcePath) === path.resolve(job.outputPaths.project)
                )?.archivePath || null,
            archivedRenderPath:
                files.find(
                    (file) =>
                        job.outputPaths.render &&
                        path.resolve(file.sourcePath) === path.resolve(job.outputPaths.render)
                )?.archivePath || null,
        };
        writeJsonAtomic(path.join(job.workspace, "archive-receipt.json"), receipt);
        return receipt;
    }
}

module.exports = { ArchiveManager, ArchiveError, sha256 };
