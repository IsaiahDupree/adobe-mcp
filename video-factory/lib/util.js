const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function nowIso() {
    return new Date().toISOString();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value, fallback = "video") {
    const slug = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return slug || fallback;
}

function ensureDir(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function writeJsonAtomic(filePath, value) {
    ensureDir(path.dirname(filePath));
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function run(command, args = [], options = {}) {
    return execFileAsync(command, args, {
        timeout: options.timeout || 30000,
        maxBuffer: 4 * 1024 * 1024,
        ...options,
    });
}

async function commandExists(command) {
    try {
        await run("/usr/bin/which", [command]);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    commandExists,
    ensureDir,
    execFileAsync,
    nowIso,
    readJson,
    run,
    sleep,
    slugify,
    writeJsonAtomic,
};
