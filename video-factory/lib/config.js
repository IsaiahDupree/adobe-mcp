const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO_ROOT = path.resolve(__dirname, "../..");
const FACTORY_HOME = path.resolve(
    process.env.VIDEO_FACTORY_HOME || path.join(REPO_ROOT, "../../premiere-autonomy/factory")
);
const FACTORY_PACKAGE_DIR = path.resolve(__dirname, "..");

function envValue(name, fallback = "") {
    if (process.env[name]) return process.env[name];
    const envPath = path.join(process.env.HOME || "", ".env");
    try {
        const line = fs
            .readFileSync(envPath, "utf8")
            .split(/\r?\n/)
            .find((item) => item.startsWith(`${name}=`));
        if (!line) return fallback;
        const value = line.slice(name.length + 1).trim();
        return value.replace(/^(['"])(.*)\1$/, "$2");
    } catch {
        return fallback;
    }
}

module.exports = {
    REPO_ROOT,
    FACTORY_PACKAGE_DIR,
    FACTORY_HOME,
    JOBS_DIR: path.join(FACTORY_HOME, "jobs"),
    COMPOSITIONS_DIR: path.join(FACTORY_HOME, "compositions"),
    FRAMING_DIR: path.join(FACTORY_HOME, "framing"),
    REVISE_DIR: path.join(FACTORY_HOME, "revise"),
    CAMPAIGNS_DIR: path.join(FACTORY_HOME, "campaigns"),
    BOARDS_DIR: path.join(FACTORY_HOME, "boards"),
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
    PREMIERE_CEP_TEMP_DIR:
        process.env.PREMIERE_CEP_TEMP_DIR || path.join(os.tmpdir(), "premiere-mcp-bridge"),
    PREMIERE_CEP_TIMEOUT_MS: Number(process.env.PREMIERE_CEP_TIMEOUT_MS || 60000),
    PREMIERE_H264_PRESET:
        process.env.PREMIERE_H264_PRESET ||
        "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/00 - Match Source - High bitrate.epr",
    IMAGEMAGICK_BIN: process.env.IMAGEMAGICK_BIN || "/opt/homebrew/bin/magick",
    FFMPEG_BIN: process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg",
    FFPROBE_BIN: process.env.FFPROBE_BIN || "ffprobe",
    YT_DLP_BIN: process.env.YT_DLP_BIN || "/opt/homebrew/bin/yt-dlp",
    PYTHON_BIN: process.env.VIDEO_FACTORY_PYTHON_BIN || "/opt/homebrew/bin/python3",
    CODEX_JUDGE_TIMEOUT_MS: Number(process.env.VIDEO_FACTORY_CODEX_JUDGE_TIMEOUT_MS || 180000),
    CAPTION_FONT:
        process.env.VIDEO_FACTORY_CAPTION_FONT ||
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    MIN_DISK_FREE_GB: Number(process.env.VIDEO_FACTORY_MIN_DISK_FREE_GB || 5),
    HEYGEN_API_URL: process.env.HEYGEN_API_URL || "https://api.heygen.com",
    HEYGEN_API_KEY: envValue("HEYGEN_API_KEY"),
    PEXELS_API_KEY: envValue("PEXELS_API_KEY"),
    PIXABAY_API_KEY: envValue("PIXABAY_API_KEY"),
    HEYGEN_AVATAR_ID: envValue(
        "HEYGEN_AVATAR_ID",
        "d9af08b6f80349aaa56096443f91d19e"
    ),
    HEYGEN_VOICE_ID: envValue(
        "HEYGEN_VOICE_ID",
        "e40f41c567924222a60ed3e1d557fc77"
    ),
    PASSPORT_MOUNT:
        process.env.VIDEO_FACTORY_PASSPORT_MOUNT || "/Volumes/My Passport",
    PASSPORT_ARCHIVE_ROOT:
        process.env.VIDEO_FACTORY_ARCHIVE_ROOT || "/Volumes/My Passport/VideoFactory",
};
