import { GoogleGenAI } from '@google/genai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { withGeminiKey } from './geminiApiKeys.js';

const execFileAsync = promisify(execFile);

export async function generateVoiceover(script, language, jobDir) {
  const response = await withGeminiKey(async (apiKey) => {
    const ai = new GoogleGenAI({ apiKey });
    return ai.models.generateContent({
      model: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text: `Read this ${language} YouTube Short script clearly and expressively:\n${script}` }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
      }
    });
  });
  const audioPart = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
  if (!audioPart) throw new Error('Gemini TTS returned no audio.');
  const wav = path.join(jobDir, 'voiceover.wav');
  const mp3 = path.join(jobDir, 'voiceover.mp3');
  const data = Buffer.from(audioPart.inlineData.data, 'base64');
  const mimeType = audioPart.inlineData.mimeType || 'audio/L16;rate=24000';
  const rate = Number(mimeType.match(/rate=(\d+)/)?.[1] || 24000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const fs = await import('node:fs/promises');
  await fs.writeFile(wav, Buffer.concat([header, data]));
  await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', wav,
    '-codec:a', 'libmp3lame', '-b:a', '128k', mp3
  ], { timeout: 60000, maxBuffer: 50 * 1024 * 1024 });
  return mp3;
}
