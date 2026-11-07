// Text-to-speech: reads messages from a chosen text channel aloud in a voice channel.
// Uses @discordjs/voice with Google Translate TTS (no API key required).
import { Readable } from 'node:stream';
import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    entersState,
    getVoiceConnection,
    VoiceConnectionStatus,
    AudioPlayerStatus,
} from '@discordjs/voice';
import { getAllAudioUrls } from 'google-tts-api';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { logger } from '../utils/logger.js';
import { getGuildConfig, setGuildConfig } from './config/guildConfig.js';

const MAX_SPOKEN_CHARS = 200;
const MAX_QUEUE = 10;
const DEFAULT_LANG = 'en';

export const TTS_DEFAULTS = { volume: 100, wps: 2.5 }; // volume in percent, speed in words per second
export const TTS_LIMITS = { volumeMin: 1, volumeMax: 200, wpsMin: 1, wpsMax: 5 };

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

export async function getTtsSettings(client, guildId) {
    const config = (await getGuildConfig(client, guildId).catch(() => null)) || {};
    return {
        volume: clamp(Number(config.ttsVolume) || TTS_DEFAULTS.volume, TTS_LIMITS.volumeMin, TTS_LIMITS.volumeMax),
        wps: clamp(Number(config.ttsWps) || TTS_DEFAULTS.wps, TTS_LIMITS.wpsMin, TTS_LIMITS.wpsMax),
    };
}

export async function saveTtsSettings(client, guildId, { volume, wps }) {
    const config = (await getGuildConfig(client, guildId)) || {};
    if (volume !== undefined) config.ttsVolume = clamp(volume, TTS_LIMITS.volumeMin, TTS_LIMITS.volumeMax);
    if (wps !== undefined) config.ttsWps = clamp(wps, TTS_LIMITS.wpsMin, TTS_LIMITS.wpsMax);
    await setGuildConfig(client, guildId, config);
    const settings = await getTtsSettings(client, guildId);
    const session = sessions.get(guildId);
    if (session) session.settings = settings;
    return settings;
}
const VOICE = process.env.TTS_VOICE || 'en-GB-RyanNeural'; // British male

// guildId -> { textChannelId, voiceChannelId, player, queue: [], busy: boolean }
const sessions = new Map();

/** Everything before the last "|" in a name is dropped: "[TAG] | Bob" -> "Bob". */
export function spokenName(name) {
    const raw = String(name ?? '');
    const idx = raw.lastIndexOf('|');
    const after = idx === -1 ? raw : raw.slice(idx + 1);
    return after.trim() || raw.replace(/\|/g, '').trim() || 'Someone';
}

export function cleanForSpeech(text) {
    return String(text ?? '')
        .replace(/https?:\/\/\S+/gi, 'link')
        .replace(/<a?:(\w+):\d+>/g, '$1')
        .replace(/[*_~`>|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchEdgeAudio(text, wps) {
    const tts = new MsEdgeTTS();
    try {
        await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(text, { rate: Number((wps / TTS_DEFAULTS.wps).toFixed(2)) });
        const chunks = [];
        for await (const chunk of audioStream) chunks.push(chunk);
        const audio = Buffer.concat(chunks);
        if (!audio.length) throw new Error('empty audio');
        return audio;
    } finally {
        tts.close();
    }
}

async function fetchGoogleAudio(text) {
    const parts = getAllAudioUrls(text, { lang: DEFAULT_LANG, slow: false });
    const bufs = [];
    for (const part of parts) {
        const res = await fetch(part.url);
        if (!res.ok) throw new Error(`TTS fetch failed: ${res.status}`);
        bufs.push(Buffer.from(await res.arrayBuffer()));
    }
    return Buffer.concat(bufs);
}

async function fetchAudio(text, wps) {
    try {
        return await fetchEdgeAudio(text, wps);
    } catch (error) {
        logger.warn(`Edge TTS failed (${error.message}); falling back to Google voice.`);
        return fetchGoogleAudio(text);
    }
}

async function drain(guildId) {
    const session = sessions.get(guildId);
    if (!session || session.busy) return;
    session.busy = true;
    try {
        while (session.queue.length) {
            const line = session.queue.shift();
            try {
                const audio = await fetchAudio(line, session.settings.wps);
                const resource = createAudioResource(Readable.from(audio), { inlineVolume: true });
                resource.volume.setVolume(session.settings.volume / 100);
                session.player.play(resource);
                await entersState(session.player, AudioPlayerStatus.Playing, 10_000);
                await entersState(session.player, AudioPlayerStatus.Idle, 90_000);
            } catch (error) {
                logger.warn(`TTS playback failed in guild ${guildId}: ${error.message}`);
            }
        }
    } finally {
        session.busy = false;
    }
}

export function getTtsSession(guildId) {
    return sessions.get(guildId) || null;
}

export async function startTts({ guild, voiceChannel, textChannelId, settings = TTS_DEFAULTS }) {
    stopTts(guild.id);

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
        connection.destroy();
        throw error;
    }

    const player = createAudioPlayer();
    connection.subscribe(player);
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch {
            stopTts(guild.id);
        }
    });

    sessions.set(guild.id, { textChannelId, voiceChannelId: voiceChannel.id, player, queue: [], busy: false, lastSpeakerId: null, settings });
}

export function stopTts(guildId) {
    const session = sessions.get(guildId);
    if (session) {
        session.queue.length = 0;
        session.player.stop(true);
        sessions.delete(guildId);
    }
    const connection = getVoiceConnection(guildId);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
    }
    return Boolean(session);
}

/** Called for every guild message; speaks it if it is in the active TTS channel. */
export function handleTtsMessage(message, prefix) {
    const session = sessions.get(message.guild.id);
    if (!session || message.channel.id !== session.textChannelId) return;
    if (prefix && message.content.startsWith(prefix)) return;

    // Only read users who are in the same voice channel as the bot.
    if (message.member?.voice?.channelId !== session.voiceChannelId) return;

    const body = cleanForSpeech(message.cleanContent).slice(0, MAX_SPOKEN_CHARS);
    if (!body) return;
    if (session.queue.length >= MAX_QUEUE) return;

    // Skip the name when the previous message read aloud was from the same person.
    if (session.lastSpeakerId === message.author.id) {
        session.queue.push(body);
    } else {
        const name = cleanForSpeech(spokenName(message.member?.displayName ?? message.author.username));
        session.queue.push(`${name} says ${body}`);
    }
    session.lastSpeakerId = message.author.id;
    drain(message.guild.id);
}
