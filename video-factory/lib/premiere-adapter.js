const path = require("path");
const { io } = require(path.join(
    __dirname,
    "../../proxy-server/node_modules/socket.io-client"
));

class PremiereCommandError extends Error {
    constructor(message, packet) {
        super(message);
        this.name = "PremiereCommandError";
        this.code = "PREMIERE_COMMAND_FAILED";
        this.packet = packet;
    }
}

class PremiereAdapter {
    constructor(config) {
        this.proxyUrl = config.PROXY_URL;
        this.timeoutMs = config.COMMAND_TIMEOUT_MS;
        this.application = "premiere";
    }

    command(action, options = {}, timeoutMs = this.timeoutMs) {
        return new Promise((resolve, reject) => {
            const socket = io(this.proxyUrl, {
                transports: ["websocket"],
                reconnection: false,
            });
            let settled = false;

            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.close();
                callback(value);
            };

            const timer = setTimeout(() => {
                finish(
                    reject,
                    new PremiereCommandError(`Timed out waiting for ${action}.`, {
                        status: "TIMEOUT",
                    })
                );
            }, timeoutMs);

            socket.on("connect", () => {
                socket.emit("command_packet", {
                    application: this.application,
                    command: { action, options },
                });
            });

            socket.on("packet_response", (packet) => {
                if (packet.status !== "SUCCESS") {
                    finish(
                        reject,
                        new PremiereCommandError(
                            packet.message || `${action} failed in Premiere.`,
                            packet
                        )
                    );
                    return;
                }
                finish(resolve, packet);
            });

            socket.on("connect_error", (error) => {
                const wrapped = new PremiereCommandError(
                    `Could not connect to Premiere proxy: ${error.message || error}`,
                    { status: "CONNECTION_ERROR" }
                );
                wrapped.code = "BRIDGE_UNAVAILABLE";
                finish(reject, wrapped);
            });
        });
    }

    async inspectProject() {
        const packet = await this.command("getProjectInfo");
        return {
            project: packet.response || { hasProject: false },
            sequences: packet.sequences || [],
            projectItems: packet.projectItems || [],
            snapshotWarning: packet.snapshotWarning || null,
        };
    }

    async isConnected() {
        try {
            const response = await fetch(`${this.proxyUrl}/status`, {
                signal: AbortSignal.timeout(3000),
            });
            const status = await response.json();
            return Boolean(status.clients && Number(status.clients.premiere || 0) > 0);
        } catch {
            return false;
        }
    }
}

module.exports = { PremiereAdapter, PremiereCommandError };
