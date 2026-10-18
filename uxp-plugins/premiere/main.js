/* MIT License
 *
 * Copyright (c) 2025 Mike Chambers
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const { entrypoints } = require("uxp");
const { io } = require("./socket.io.js");
const app = require("premierepro");

const {
    getSequences,
    getProjectContentInfo,
    parseAndRouteCommand,
    checkRequiresActiveProject,
} = require("./commands/index.js");

const APPLICATION = "premiere";
const PROXY_URL = "http://localhost:3031";
const CONNECT_ON_LAUNCH = "connectOnLaunch";
const MAX_LOG_ENTRIES = 80;

let socket = null;
let elements = {};
let lastSnapshot = null;
let logEntries = [];

entrypoints.setup({
    panels: {
        vanilla: {
            show() {},
        },
    },
});

const now = () => new Date().toLocaleTimeString();

const escapeHtml = (value) =>
    String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

const countClips = (sequences) =>
    sequences.reduce((total, sequence) => {
        const videoClips = sequence.videoTracks.reduce(
            (sum, track) => sum + track.tracks.length,
            0
        );
        const audioClips = sequence.audioTracks.reduce(
            (sum, track) => sum + track.tracks.length,
            0
        );
        return total + videoClips + audioClips;
    }, 0);

const getActiveSequence = (sequences) =>
    sequences.find((sequence) => sequence.isActive) || null;

const setAlert = (message) => {
    if (!elements.alert) {
        return;
    }

    elements.alert.hidden = !message;
    elements.alert.textContent = message || "";
};

const addLog = (level, message, details) => {
    const entry = {
        level,
        message,
        details,
        time: now(),
    };

    logEntries.unshift(entry);
    logEntries = logEntries.slice(0, MAX_LOG_ENTRIES);
    renderLog();

    const consoleMessage = `[Premiere MCP] ${message}`;
    if (level === "error") {
        console.error(consoleMessage, details || "");
    } else if (level === "warn") {
        console.warn(consoleMessage, details || "");
    } else {
        console.log(consoleMessage, details || "");
    }
};

const formatDetails = (details) => {
    if (!details) {
        return "";
    }

    if (typeof details === "string") {
        return ` ${details}`;
    }

    try {
        return ` ${JSON.stringify(details)}`;
    } catch {
        return ` ${String(details)}`;
    }
};

const renderLog = () => {
    if (!elements.eventLog) {
        return;
    }

    if (logEntries.length === 0) {
        elements.eventLog.innerHTML =
            '<div class="muted">Waiting for plugin events.</div>';
        return;
    }

    elements.eventLog.innerHTML = logEntries
        .map(
            (entry) =>
                `<div class="log-entry log-${entry.level}"><span class="log-time">${escapeHtml(entry.time)}</span> ${escapeHtml(entry.message)}${escapeHtml(formatDetails(entry.details))}</div>`
        )
        .join("");
};

const renderConnection = () => {
    const connected = socket && socket.connected;
    const label = connected ? "Connected" : "Disconnected";

    elements.btnStart.textContent = connected ? "Disconnect" : "Connect";
    elements.statusPill.textContent = label;
    elements.statusPill.className = connected
        ? "status status-on"
        : "status status-off";
    elements.connectionMeta.textContent = connected
        ? `${PROXY_URL} · ${socket.id}`
        : `Proxy ${PROXY_URL}`;
};

const renderSnapshot = (snapshot) => {
    lastSnapshot = snapshot;

    const sequences = snapshot.sequences || [];
    const projectItems = snapshot.projectItems || [];
    const activeSequence = getActiveSequence(sequences);

    elements.sequenceCount.textContent = sequences.length.toString();
    elements.itemCount.textContent = projectItems.length.toString();
    elements.clipCount.textContent = countClips(sequences).toString();
    elements.activeSequence.textContent = activeSequence
        ? activeSequence.name
        : "No active sequence";

    if (sequences.length === 0) {
        elements.sequenceList.className = "list empty";
        elements.sequenceList.textContent = "No sequences found.";
        return;
    }

    elements.sequenceList.className = "list";
    elements.sequenceList.innerHTML = sequences
        .map((sequence) => {
            const videoClips = sequence.videoTracks.reduce(
                (sum, track) => sum + track.tracks.length,
                0
            );
            const audioClips = sequence.audioTracks.reduce(
                (sum, track) => sum + track.tracks.length,
                0
            );
            const size = sequence.frameSize
                ? `${sequence.frameSize.width}x${sequence.frameSize.height}`
                : "unknown size";
            const badge = sequence.isActive
                ? '<span class="badge">Active</span>'
                : "";

            return `<div class="sequence-row">
                <div>
                  <div class="sequence-name">${escapeHtml(sequence.name)}</div>
                  <div class="sequence-meta">${escapeHtml(size)} · ${videoClips} video · ${audioClips} audio</div>
                </div>
                ${badge}
              </div>`;
        })
        .join("");
};

const getProjectSnapshot = async () => {
    const probeCommand = { action: "getProjectInfo", options: {} };
    await checkRequiresActiveProject(probeCommand);

    const project = await app.Project.getActiveProject();
    if (!project) {
        throw new Error("No active Premiere project.");
    }

    return {
        sequences: await getSequences(),
        projectItems: await getProjectContentInfo(),
    };
};

const refreshProjectSnapshot = async () => {
    setAlert("");
    addLog("ok", "Refreshing project snapshot");

    try {
        const snapshot = await getProjectSnapshot();
        renderSnapshot(snapshot);
        addLog("ok", "Project snapshot ready", {
            sequences: snapshot.sequences.length,
            projectItems: snapshot.projectItems.length,
        });
        return snapshot;
    } catch (error) {
        const message = `Refresh failed: ${error.message || error}`;
        setAlert(message);
        addLog("error", message);
        throw error;
    }
};

const tryProjectSnapshot = async () => {
    try {
        const snapshot = await getProjectSnapshot();
        renderSnapshot(snapshot);
        return { snapshot };
    } catch (error) {
        const warning = `Snapshot unavailable: ${error.message || error}`;
        addLog("warn", warning);
        return { warning };
    }
};

const runLocalCommand = async (command) => {
    setAlert("");
    const started = Date.now();
    addLog("ok", `Running ${command.action}`);

    try {
        await checkRequiresActiveProject(command);
        const response = await parseAndRouteCommand(command);
        const { warning } = await tryProjectSnapshot();
        addLog("ok", `${command.action} complete`, {
            ms: Date.now() - started,
            warning,
        });
        return response;
    } catch (error) {
        const message = `${command.action} failed: ${error.message || error}`;
        setAlert(message);
        addLog("error", message);
        throw error;
    }
};

const onCommandPacket = async (packet) => {
    const command = packet.command;
    const started = Date.now();
    const out = {
        senderId: packet.senderId,
    };

    addLog("ok", `MCP command received: ${command.action}`);

    try {
        await checkRequiresActiveProject(command);

        const response = await parseAndRouteCommand(command);
        const { snapshot, warning } = await tryProjectSnapshot();

        out.response = response;
        out.status = "SUCCESS";
        out.sequences = snapshot ? snapshot.sequences : [];
        out.projectItems = snapshot ? snapshot.projectItems : [];
        if (warning) {
            out.snapshotWarning = warning;
        }

        addLog("ok", `MCP command complete: ${command.action}`, {
            ms: Date.now() - started,
            warning,
        });
    } catch (error) {
        out.status = "FAILURE";
        out.message = `Error calling ${command.action}: ${
            error.message || error
        }`;
        setAlert(out.message);
        addLog("error", out.message);
    }

    return out;
};

function connectToServer() {
    if (socket && socket.connected) {
        return socket;
    }

    socket = io(PROXY_URL, {
        transports: ["websocket"],
    });

    socket.on("connect", () => {
        renderConnection();
        addLog("ok", "Connected to proxy", { id: socket.id });
        socket.emit("register", { application: APPLICATION });
    });

    socket.on("command_packet", async (packet) => {
        const response = await onCommandPacket(packet);
        sendResponsePacket(response);
    });

    socket.on("registration_response", (data) => {
        addLog("ok", "Registered with proxy", data);
    });

    socket.on("connect_error", (error) => {
        renderConnection();
        setAlert(`Proxy connection failed: ${error.message || error}`);
        addLog("error", "Proxy connection failed", error.message || error);
    });

    socket.on("disconnect", (reason) => {
        renderConnection();
        addLog("warn", "Disconnected from proxy", reason);
    });

    renderConnection();
    addLog("ok", "Connecting to proxy");
    return socket;
}

function disconnectFromServer() {
    if (socket && socket.connected) {
        socket.disconnect();
    }
    renderConnection();
}

function sendResponsePacket(packet) {
    if (socket && socket.connected) {
        socket.emit("command_packet_response", {
            packet: packet,
        });
        addLog("ok", "MCP response sent", { status: packet.status });
        return true;
    }

    addLog("warn", "MCP response not sent; proxy disconnected");
    return false;
}

function getConnectOnLaunch() {
    const storedValue = window.localStorage.getItem(CONNECT_ON_LAUNCH);
    if (storedValue === null) {
        return true;
    }

    return JSON.parse(storedValue);
}

function setConnectOnLaunch(value) {
    window.localStorage.setItem(CONNECT_ON_LAUNCH, JSON.stringify(value));
}

function wireEvents() {
    elements.btnStart.addEventListener("click", () => {
        if (socket && socket.connected) {
            disconnectFromServer();
        } else {
            connectToServer();
        }
    });

    elements.btnRefresh.addEventListener("click", () => {
        refreshProjectSnapshot().catch(() => {});
    });

    elements.btnSave.addEventListener("click", () => {
        runLocalCommand({ action: "saveProject", options: {} }).catch(() => {});
    });

    elements.btnClearLog.addEventListener("click", () => {
        logEntries = [];
        renderLog();
    });

    elements.chkConnectOnLaunch.addEventListener("change", (event) => {
        setConnectOnLaunch(event.target.checked);
    });
}

function initPanel() {
    elements = {
        alert: document.getElementById("alert"),
        activeSequence: document.getElementById("activeSequence"),
        btnClearLog: document.getElementById("btnClearLog"),
        btnRefresh: document.getElementById("btnRefresh"),
        btnSave: document.getElementById("btnSave"),
        btnStart: document.getElementById("btnStart"),
        chkConnectOnLaunch: document.getElementById("chkConnectOnLaunch"),
        clipCount: document.getElementById("clipCount"),
        connectionMeta: document.getElementById("connectionMeta"),
        eventLog: document.getElementById("eventLog"),
        itemCount: document.getElementById("itemCount"),
        sequenceCount: document.getElementById("sequenceCount"),
        sequenceList: document.getElementById("sequenceList"),
        statusPill: document.getElementById("statusPill"),
    };

    elements.chkConnectOnLaunch.checked = getConnectOnLaunch();
    wireEvents();
    renderConnection();
    renderLog();
    addLog("ok", "Panel ready");

    window.__premiereMcpAgent = {
        connect: connectToServer,
        disconnect: disconnectFromServer,
        refresh: refreshProjectSnapshot,
        run: runLocalCommand,
        getSnapshot: () => lastSnapshot,
    };

    if (getConnectOnLaunch()) {
        connectToServer();
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPanel);
} else {
    initPanel();
}
