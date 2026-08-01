const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const FACTORY_HOME = path.resolve(
    process.env.VIDEO_FACTORY_HOME || path.join(REPO_ROOT, "../../premiere-autonomy/factory")
);

module.exports = {
    REPO_ROOT,
    FACTORY_HOME,
    JOBS_DIR: path.join(FACTORY_HOME, "jobs"),
    CAMPAIGNS_DIR: path.join(FACTORY_HOME, "campaigns"),
    PROXY_URL: process.env.PROXY_URL || "http://127.0.0.1:3031",
    FACTORY_PORT: Number(process.env.VIDEO_FACTORY_PORT || 3032),
    PREMIERE_APP_NAME: process.env.PREMIERE_APP_NAME || "Adobe Premiere Pro 2026",
    PREMIERE_APP_PATH:
        process.env.PREMIERE_APP_PATH ||
        "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app",
    MEDIA_ENCODER_APP_NAME:
        process.env.MEDIA_ENCODER_APP_NAME || "Adobe Media Encoder 2026",
    MEDIA_ENCODER_APP_PATH:
        process.env.MEDIA_ENCODER_APP_PATH ||
        "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app",
    UDT_APP_NAME: "Adobe UXP Developer Tools",
    UDT_APP_PATH:
        "/Applications/Adobe UXP Developer Tools/Adobe UXP Developer Tools.app",
    UXP_CLI: process.env.UXP_CLI || "/opt/homebrew/bin/uxp",
    INSTALLED_PLUGIN_DIR:
        process.env.PREMIERE_UXP_PLUGIN_DIR ||
        path.join(
            process.env.HOME || "",
            "Library/Application Support/Adobe/UXP/Plugins/External/Premiere-MCP-Agent_0.85.3"
        ),
    PROXY_LAUNCH_LABEL:
        process.env.PREMIERE_PROXY_LAUNCH_LABEL || "com.isaiah.adobe-mcp-proxy",
    FACTORY_LAUNCH_LABEL:
        process.env.VIDEO_FACTORY_LAUNCH_LABEL || "com.isaiah.premiere-video-factory",
    COMMAND_TIMEOUT_MS: Number(process.env.PREMIERE_COMMAND_TIMEOUT_MS || 60000),
    APP_READY_TIMEOUT_MS: Number(process.env.PREMIERE_READY_TIMEOUT_MS || 120000),
    MIN_DISK_FREE_GB: Number(process.env.VIDEO_FACTORY_MIN_DISK_FREE_GB || 5),
};
