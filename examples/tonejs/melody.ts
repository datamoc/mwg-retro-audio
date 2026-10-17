/** Original generated four-second phrase; no external recording or ROM. Released under the repository MPL-2.0. */
export function demoYm(): Uint8Array {
	const bytes: number[] = [];
	const text = (value: string): void => {
		bytes.push(...Array.from(value, (char) => char.charCodeAt(0)));
	};
	const word = (value: number): void => {
		bytes.push((value >>> 8) & 255, value & 255);
	};
	const long = (value: number): void => {
		bytes.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
	};
	text('YM6!LeOnArD!');
	long(200);
	long(0);
	word(0);
	long(2_000_000);
	word(50);
	long(0);
	word(0);
	text('Shared clock\0mwg-retro-audio\0Original generated demo\0');
	const notes = [60, 64, 67, 72, 65, 69, 67, 60];
	for (let frame = 0; frame < 200; frame++) {
		const hz = 440 * 2 ** ((notes[Math.floor(frame / 25)] - 69) / 12);
		const period = Math.round(2_000_000 / (16 * hz));
		bytes.push(period & 255, period >>> 8, 0, 0, 0, 0, 0, 62, frame % 25 < 20 ? 12 : 0, 0, 0, 0, 0, 0, 0, 0);
	}
	text('End!');
	return new Uint8Array(bytes);
}
