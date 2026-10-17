import type { AudioSettingsData } from '@datamoc/mw_games/audio';
import type { OutputStageOptions } from '../driver/OutputStage.ts';
import type { PsidOptions } from '../formats/psid.ts';
import { Region } from '../region.ts';
import type { SfxEngineOptions } from '../sfx/engine.ts';

/**
 * mwg's player-facing `AudioSettings` drive machines, not files: the engine keeps the
 * standard a file was authored at (clocks and pitch come from it), and these helpers say
 * what the settings do change — the standard forced on files that leave it open, and how
 * the output stage is treated on the way to the player's ears.
 */

/** load options the settings imply: the PSID standard, where the file itself is silent about it */
export function retroLoadFor(settings: AudioSettingsData): Pick<PsidOptions, 'standard'> {
	return { standard: settings.region };
}

/** the tick of an `SfxEngine`: the settings' region, 50 or 60 Hz, drives effect curves */
export function retroSfxEngineOptionsFor(settings: AudioSettingsData, sampleRate?: number): SfxEngineOptions {
	return {
		region: settings.region === 'pal' ? Region.PAL : Region.NTSC,
		...(sampleRate === undefined ? {} : { sampleRate }),
	};
}

/**
 * the engine's `OutputStageOptions` for the settings: `faithful` keeps what the hardware
 * did (DC offset and top end included), `clean` removes the DC and asks the mwg soften
 * curve for a cutoff — 18 kHz at `soften` 0 (open), 3.5 kHz at 1, never past half the
 * sample rate. The formula mirrors `softenCutoff` of `@datamoc/mw_games/audio` on purpose
 * (this layer stays type-only against mwg); `tests/mwg.test.ts` pins the two together.
 * The `dynamics` dial is per-sample soft limiting: it belongs to the bus, past the engine,
 * where mwg's `dynamicsLimit` already applies it.
 */
export function retroOutputFor(settings: AudioSettingsData, sampleRate: number): OutputStageOptions {
	if (settings.outputStage !== 'clean') return {};
	const amount = Math.min(1, Math.max(0, settings.soften));
	return { dcBlock: true, lowpass: Math.min(18000 * (3500 / 18000) ** amount, sampleRate / 2) };
}
