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

const MAX_SPOKEN_CHARS = 200;
const MAX_QUEUE = 10;
const DEFAULT_LANG = 'en';
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

async function fetchEdgeAudio(text) {
    const tts = new MsEdgeTTS();
    try {
        await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(text);
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

async function fetchAudio(text) {
    try {
        return await fetchEdgeAudio(text);
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
                const audio = await fetchAudio(line);
                session.player.play(createAudioResource(Readable.from(audio)));
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

export async function startTts({ guild, voiceChannel, textChannelId }) {
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

    sessions.set(guild.id, { textChannelId, voiceChannelId: voiceChannel.id, player, queue: [], busy: false });
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

    const name = cleanForSpeech(spokenName(message.member?.displayName ?? message.author.username));
    session.queue.push(`${name} says ${body}`);
    drain(message.guild.id);
}
