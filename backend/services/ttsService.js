import { GoogleGenAI } from '@google/genai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { FFMPEG_TIMEOUT_MS } from './renderService.js';
import { withGeminiKey } from './geminiApiKeys.js';

const execFileAsync = promisify(execFile);
const MAX_TTS_ATTEMPTS = 3;
const TTS_RETRY_BASE_MS = 500;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function sanitizeNarrationText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/[*_~`#|]/g, '')
    .replace(/[^\p{L}\p{N}\s.,!?;:'’‘“”\-–—।॥]/gu, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function generateTtsAudio(script, language, generateResponse, wait = delay) {
  let narration = String(script || '');
  let lastError;
  for (let attempt = 0; attempt < MAX_TTS_ATTEMPTS; attempt += 1) {
    try {
      const response = await generateResponse(narration, language);
      const audioPart = response?.candidates
        ?.flatMap((candidate) => candidate?.content?.parts || [])
        .find((part) => typeof part?.inlineData?.data === 'string');
      const data = audioPart ? Buffer.from(audioPart.inlineData.data, 'base64') : Buffer.alloc(0);
      if (data.length) {
        return {
          data,
          mimeType: audioPart.inlineData.mimeType || 'audio/L16;rate=24000'
        };
      }
      lastError = new Error('Gemini TTS returned no audio.');
      narration = sanitizeNarrationText(script);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const status = Number(error?.status ?? error?.response?.status);
      if (/Configure at least one Gemini API key/.test(error?.message || '') ||
          (status >= 400 && status < 500 && status !== 429)) {
        throw error;
      }
      lastError = error;
    }
    if (attempt + 1 < MAX_TTS_ATTEMPTS) {
      await wait(TTS_RETRY_BASE_MS * (2 ** attempt));
    }
  }
  if (lastError?.message === 'Gemini TTS returned no audio.') {
    throw new Error(`Gemini TTS returned no audio after ${MAX_TTS_ATTEMPTS} attempts.`);
  }
  throw lastError || new Error('Gemini TTS audio generation failed.');
}

export async function generateVoiceover(script, language, jobDir, signal) {
  const { data, mimeType } = await generateTtsAudio(script, language, (narration, requestedLanguage) =>
    withGeminiKey(async (apiKey) => {
      const ai = new GoogleGenAI({ apiKey });
      return ai.models.generateContent({
        model: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: `Read this ${requestedLanguage} YouTube Short script clearly and expressively:\n${narration}` }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      });
    }));
  const wav = path.join(jobDir, 'voiceover.wav');
  const mp3 = path.join(jobDir, 'voiceover.mp3');
  const rate = Number(mimeType.match(/rate=(\d+)/)?.[1] || 24000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const fs = await import('node:fs/promises');
  let encoded = false;
  try {
    await fs.writeFile(wav, Buffer.concat([header, data]));
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-i', wav,
      '-codec:a', 'libmp3lame', '-b:a', '128k', mp3
    ], { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, signal });
    encoded = true;
    return mp3;
  } finally {
    await fs.rm(wav, { force: true });
    if (!encoded) await fs.rm(mp3, { force: true });
  }
}
