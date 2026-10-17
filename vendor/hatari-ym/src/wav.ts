import { writeFileSync } from 'node:fs';

/** Write mono 16-bit PCM as a WAV file (or stereo if `stereo`: the sample is duplicated, as Hatari does). */
export function writeWav(path: string, samples: Int16Array, sampleRate = 44100, stereo = true): void {
	const ch = stereo ? 2 : 1;
	const data = Buffer.alloc(44 + samples.length * 2 * ch);
	data.write('RIFF', 0); data.writeUInt32LE(36 + samples.length * 2 * ch, 4); data.write('WAVEfmt ', 8);
	data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(ch, 22);
	data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 2 * ch, 28);
	data.writeUInt16LE(2 * ch, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
	data.writeUInt32LE(samples.length * 2 * ch, 40);
	let o = 44;
	for (let i = 0; i < samples.length; i++) {
		data.writeInt16LE(samples[i], o); o += 2;
		if (stereo) { data.writeInt16LE(samples[i], o); o += 2; }
	}
	writeFileSync(path, data);
}
