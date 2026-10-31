import { spawn } from 'node:child_process';
import { parseWav } from '../formats/pcm.ts';
import type { SpeechResult } from '../speech/speechRender.ts';

export interface WindowsSpeechOptions {
	language?: string;
	/** Exact installed SAPI voice name. */
	voice?: string;
	/** SAPI rate, -10..10 (default 0). */
	rate?: number;
	/** Volume, 0..1 (default 1). */
	volume?: number;
}

// Fixed script: text and voice names arrive as JSON on stdin, never as executable PowerShell.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$stream = New-Object System.IO.MemoryStream
try {
    if ($request.voice) { $synth.SelectVoice($request.voice) }
    else {
        $culture = [System.Globalization.CultureInfo]::GetCultureInfo($request.language)
        $synth.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet,
            [System.Speech.Synthesis.VoiceAge]::NotSet, 0, $culture)
        if ($synth.Voice.Culture.TwoLetterISOLanguageName -ne $culture.TwoLetterISOLanguageName) {
            throw "No installed speech voice for $($request.language)"
        }
    }
    $synth.Rate = $request.rate
    $synth.Volume = $request.volume
    $synth.SetOutputToWaveStream($stream)
    $synth.Speak($request.text)
    $synth.SetOutputToNull()
    [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} finally {
    $synth.Dispose()
    $stream.Dispose()
}
`;

/** Windows SAPI speech as mono PCM; Node only, with no neural model or runtime dependency. */
export async function synthesizeWindowsSpeech(text: string, options: WindowsSpeechOptions = {}): Promise<SpeechResult> {
	if (process.platform !== 'win32') throw new Error('Windows speech requires Windows');
	const rate = options.rate ?? 0;
	const volume = options.volume ?? 1;
	if (!Number.isInteger(rate) || rate < -10 || rate > 10) throw new RangeError('SAPI rate must be -10..10');
	if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new RangeError('Volume must be 0..1');
	if (!text.trim()) return { samples: new Float32Array(0), sampleRate: 22050 };
	const wav = await new Promise<Buffer>((resolve, reject) => {
		const child = spawn(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
			{ windowsHide: true, timeout: 120000 },
		);
		const output: Buffer[] = [];
		const errors: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
		child.on('error', reject);
		child.stdin.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) reject(new Error(`Windows speech failed: ${Buffer.concat(errors).toString('utf8')}`));
			else resolve(Buffer.from(Buffer.concat(output).toString('ascii').trim(), 'base64'));
		});
		// JSON's ASCII escapes avoid Windows PowerShell's legacy console encoding for accented text.
		const request = JSON.stringify({
			text,
			language: options.language ?? 'fr-FR',
			voice: options.voice,
			rate,
			volume: Math.round(volume * 100),
		});
		child.stdin.end(
			request.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
		);
	});
	const clip = parseWav(wav);
	const samples = new Float32Array(clip.channels[0].length);
	for (const channel of clip.channels)
		for (let i = 0; i < samples.length; i++) samples[i] += channel[i] / clip.channels.length;
	return { samples, sampleRate: clip.rate };
}
