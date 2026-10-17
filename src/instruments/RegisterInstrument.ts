import type { Chip } from '../chips/Chip.ts';
import type { Control, InstrumentInfo, InstrumentOptions } from './Instrument.ts';
import { VoiceInstrument } from './VoiceInstrument.ts';
import { VoiceAllocator } from './VoiceAllocator.ts';

export interface RegisterDriver {
	start(channel: number, hz: number, velocity: number): void;
	pitch(channel: number, hz: number): void;
	stop(channel: number): void;
	level?(channel: number, level: number): void;
	restore?(): void;
	controls?: Control[];
}

/** Native register programming with shared software envelopes, vibrato and voice stealing. */
export class RegisterInstrument extends VoiceInstrument {
	protected readonly allocator: VoiceAllocator;
	constructor(
		readonly info: InstrumentInfo,
		readonly chip: Chip,
		private readonly driver: RegisterDriver,
		options: InstrumentOptions,
	) {
		super(options);
		this.allocator = new VoiceAllocator(info.polyphony);
		this.softEnvelope = driver.level !== undefined;
		this.controls = [
			...(driver.controls ?? []),
			...(this.softEnvelope ? this.ampControls() : []),
			...this.vibratoControls(),
		];
		this.restore();
	}
	protected startVoice(channel: number, hz: number, velocity: number): void {
		this.driver.start(channel, hz, velocity);
	}
	protected stopVoice(channel: number): void {
		this.driver.stop(channel);
	}
	protected setVoicePitch(channel: number, hz: number): void {
		this.driver.pitch(channel, hz);
	}
	protected override setVoiceLevel(channel: number, level: number): void {
		this.driver.level?.(channel, level);
	}
	protected override restore(): void {
		this.driver.restore?.();
	}
}
