const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, writeJsonAtomic } = require("./util");

class ElevenLabsError extends Error {
    constructor(message, code = "ELEVENLABS_ERROR", details = {}) {
        super(message);
        this.name = "ElevenLabsError";
        this.code = code;
        this.details = details;
    }
}

class ElevenLabsManager {
    constructor(config) {
        this.apiUrl = config.ELEVENLABS_API_URL.replace(/\/$/, "");
        this.apiKey = config.ELEVENLABS_API_KEY;
    }

    async listVoices() {
        if (!this.apiKey) {
            throw new ElevenLabsError(
                "ELEVENLABS_API_KEY is not configured.",
                "ELEVENLABS_NOT_CONFIGURED"
            );
        }
        const response = await fetch(`${this.apiUrl}/v1/voices`, {
            headers: { "xi-api-key": this.apiKey },
            signal: AbortSignal.timeout(30000),
        });
        const body = await response.json();
        if (!response.ok) {
            throw new ElevenLabsError(
                `ElevenLabs voice inventory failed: ${body.detail?.message || body.detail || `HTTP ${response.status}`}`,
                "ELEVENLABS_API_FAILED",
                { status: response.status }
            );
        }
        return body.voices || [];
    }

    async generateSpeech({ text, voiceId, modelId, outputFormat, voiceSettings, destination }) {
        if (!this.apiKey) {
            throw new ElevenLabsError(
                "ELEVENLABS_API_KEY is not configured.",
                "ELEVENLABS_NOT_CONFIGURED"
            );
        }
        ensureDir(path.dirname(destination));
        const response = await fetch(
            `${this.apiUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
            {
                method: "POST",
                headers: {
                    "xi-api-key": this.apiKey,
                    "content-type": "application/json",
                    accept: "audio/mpeg",
                },
                body: JSON.stringify({
                    text,
                    model_id: modelId,
                    voice_settings: voiceSettings,
                }),
                signal: AbortSignal.timeout(120000),
            }
        );
        if (!response.ok) {
            const body = await response.text();
            let message = body.slice(0, 300);
            try {
                const parsed = JSON.parse(body);
                message = parsed.detail?.message || parsed.detail || parsed.message || message;
            } catch {
                // Preserve the bounded response text when the provider does not return JSON.
            }
            throw new ElevenLabsError(
                `ElevenLabs speech generation failed: ${message}`,
                "ELEVENLABS_API_FAILED",
                { status: response.status }
            );
        }
        const temporary = `${destination}.partial-${process.pid}`;
        fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
        if (!fs.statSync(temporary).size) {
            fs.unlinkSync(temporary);
            throw new ElevenLabsError("ElevenLabs returned empty audio.", "ELEVENLABS_EMPTY_AUDIO");
        }
        fs.renameSync(temporary, destination);
        const metadata = {
            provider: "elevenlabs",
            generatedAt: nowIso(),
            voiceId,
            modelId,
            outputFormat,
            localAudio: destination,
            bytes: fs.statSync(destination).size,
            characterCost: Number(response.headers.get("character-cost") || text.length),
            requestId: response.headers.get("request-id") || null,
        };
        writeJsonAtomic(`${destination}.json`, metadata);
        return metadata;
    }
}

module.exports = { ElevenLabsError, ElevenLabsManager };
