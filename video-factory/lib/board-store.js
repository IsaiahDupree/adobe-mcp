const fs = require("fs");
const path = require("path");
const { normalizeBoardSpec } = require("./board-schema");
const { ensureDir, nowIso, readJson, writeJsonAtomic } = require("./util");

class BoardStore {
    constructor(config) {
        this.config = config;
        ensureDir(config.BOARDS_DIR);
    }

    boardPath(id) {
        return path.join(this.config.BOARDS_DIR, id, "board.json");
    }

    submit(spec) {
        const board = normalizeBoardSpec(spec, this.config.BOARDS_DIR, this.config.PASSPORT_ARCHIVE_ROOT);
        if (fs.existsSync(this.boardPath(board.id))) throw new Error(`Board ${board.id} already exists.`);
        for (const folder of ["artifacts", "frames", "revisions", "release", "logs"]) {
            ensureDir(path.join(board.workspace, folder));
        }
        const state = {
            ...board,
            status: "REQUESTED",
            updatedAt: board.createdAt,
            startedAt: null,
            completedAt: null,
            currentRevision: 0,
            revisions: [],
            events: [],
            releaseDecision: null,
            result: null,
            error: null,
        };
        this.save(state);
        this.addEvent(state.id, "BOARD_SUBMITTED", { topic: state.topic });
        return this.get(state.id);
    }

    get(id) {
        const filePath = this.boardPath(id);
        if (!fs.existsSync(filePath)) throw new Error(`Board ${id} was not found.`);
        return readJson(filePath);
    }

    save(board) {
        board.updatedAt = nowIso();
        writeJsonAtomic(this.boardPath(board.id), board);
        return board;
    }

    addEvent(id, type, data = {}) {
        const board = this.get(id);
        const event = { at: nowIso(), type, ...data };
        board.events.push(event);
        board.events = board.events.slice(-500);
        this.save(board);
        fs.appendFileSync(path.join(board.workspace, "logs", "events.ndjson"), `${JSON.stringify(event)}\n`);
        return event;
    }

    list() {
        return fs.readdirSync(this.config.BOARDS_DIR, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && fs.existsSync(this.boardPath(entry.name)))
            .map((entry) => readJson(this.boardPath(entry.name)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
}

module.exports = { BoardStore };
