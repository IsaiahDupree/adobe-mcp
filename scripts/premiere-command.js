#!/usr/bin/env node

const path = require("path");
const { io } = require(path.join(
    __dirname,
    "../proxy-server/node_modules/socket.io-client"
));

const PROXY_URL = process.env.PROXY_URL || "http://localhost:3031";
const APPLICATION = process.env.APPLICATION || "premiere";
const TIMEOUT_MS = Number(process.env.PREMIERE_COMMAND_TIMEOUT_MS || 30000);

function printUsage() {
    console.error(`Usage:
  node scripts/premiere-command.js <action> [options-json]
  node scripts/premiere-command.js '<command-json>'

Examples:
  node scripts/premiere-command.js getProjectInfo
  node scripts/premiere-command.js openProject '{"filePath":"/path/to/project.prproj"}'`);
}

function parseCommand(argv) {
    if (argv.length === 0) {
        printUsage();
        process.exit(2);
    }

    if (argv.length === 1 && argv[0].trim().startsWith("{")) {
        const command = JSON.parse(argv[0]);
        if (!command.action) {
            throw new Error("Command JSON requires an action field.");
        }
        return {
            action: command.action,
            options: command.options || {},
        };
    }

    const action = argv[0];
    const options = argv[1] ? JSON.parse(argv[1]) : {};
    return { action, options };
}

function sendCommand(command) {
    return new Promise((resolve, reject) => {
        const socket = io(PROXY_URL, { transports: ["websocket"] });
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error(`Timed out waiting for ${command.action}`));
        }, TIMEOUT_MS);

        socket.on("connect", () => {
            socket.emit("command_packet", {
                application: APPLICATION,
                command,
            });
        });

        socket.on("packet_response", (packet) => {
            clearTimeout(timeout);
            socket.close();
            resolve(packet);
        });

        socket.on("connect_error", (error) => {
            clearTimeout(timeout);
            socket.close();
            reject(error);
        });
    });
}

async function main() {
    try {
        const command = parseCommand(process.argv.slice(2));
        const packet = await sendCommand(command);
        console.log(JSON.stringify(packet, null, 2));
        process.exit(packet.status === "SUCCESS" ? 0 : 1);
    } catch (error) {
        console.error(error.message || error);
        process.exit(1);
    }
}

main();
