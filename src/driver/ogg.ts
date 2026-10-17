/**
 * Ogg container writer for Opus (RFC 7845), in plain TypeScript. The Opus packets themselves come from an encoder
 * (`opus.ts`); this file only frames them: the `OpusHead` and `OpusTags` header pages, the audio pages with their
 * granule positions, the end-of-stream page trimmed to the real length, and the Ogg CRC.
 */
import { vorbisComment } from './vorbisComment.ts';

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i << 24;
		for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
		t[i] = c >>> 0;
	}
	return t;
})();

/** the Ogg page checksum: CRC-32, polynomial 0x04C11DB7, no reflection, no final xor, computed with the CRC field at 0 */
export function oggCrc(bytes: Uint8Array): number {
	let c = 0;
	for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
	return c >>> 0;
}

interface PageInput {
	type: number; // bit 0 continued, bit 1 first page, bit 2 last page
	granule: number;
	packets: Uint8Array[];
}

function writePage(serial: number, sequence: number, page: PageInput): Uint8Array {
	const segments: number[] = [];
	for (const p of page.packets) {
		for (let left = p.length; ; left -= 255) {
			segments.push(Math.min(255, left));
			if (left < 255) break;
		}
	}
	if (segments.length > 255) throw new RangeError('too many segments for one Ogg page');
	const body = page.packets.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(27 + segments.length + body);
	const view = new DataView(out.buffer);
	out.set([0x4f, 0x67, 0x67, 0x53, 0], 0); // "OggS", version 0
	out[5] = page.type;
	view.setUint32(6, page.granule % 2 ** 32, true);
	view.setUint32(10, Math.floor(page.granule / 2 ** 32), true);
	view.setUint32(14, serial, true);
	view.setUint32(18, sequence, true);
	out[26] = segments.length;
	out.set(segments, 27);
	let o = 27 + segments.length;
	for (const p of page.packets) {
		out.set(p, o);
		o += p.length;
	}
	view.setUint32(22, oggCrc(out), true);
	return out;
}

export interface OggOpusOptions {
	channels: number;
	/** the sample rate of the source before conversion to 48 kHz (informative, stored in OpusHead) */
	inputSampleRate: number;
	/** samples (at 48 kHz) the decoder drops at the start */
	preSkip: number;
	/** samples (at 48 kHz) of audio the file really holds: the last page's granule position trims the encoder's padding;
	 * the packets must cover `preSkip + totalSamples` samples or the end is lost */
	totalSamples: number;
	/** samples (at 48 kHz) of each packet: one number for all of them, or one per packet */
	samplesPerPacket: number | readonly number[];
	/** Vorbis comments (TITLE, ARTIST...) */
	tags?: Record<string, string>;
	vendor?: string;
	serial?: number;
	/** packets per audio page (default 48, about one second at 20 ms) */
	packetsPerPage?: number;
}

/** Wrap Opus packets in an Ogg Opus stream */
export function muxOggOpus(packets: readonly Uint8Array[], options: OggOpusOptions): Uint8Array {
	const serial = options.serial ?? 0x6d776100;
	const per = options.packetsPerPage ?? 48;
	const head = new Uint8Array(19);
	const hv = new DataView(head.buffer);
	head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
	head[8] = 1;
	head[9] = options.channels;
	hv.setUint16(10, options.preSkip, true);
	hv.setUint32(12, options.inputSampleRate, true);
	hv.setInt16(16, 0, true); // output gain
	head[18] = 0; // channel mapping family 0 (mono or stereo)
	const comment = vorbisComment(options.vendor ?? 'mwg-retro-audio', options.tags ?? {});
	const tags = new Uint8Array(8 + comment.length);
	tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // "OpusTags"
	tags.set(comment, 8);

	const pages: Uint8Array[] = [];
	let seq = 0;
	pages.push(writePage(serial, seq++, { type: 0x02, granule: 0, packets: [head] }));
	pages.push(writePage(serial, seq++, { type: 0x00, granule: 0, packets: [tags] }));
	const sizeOf = (i: number): number =>
		typeof options.samplesPerPacket === 'number' ? options.samplesPerPacket : (options.samplesPerPacket[i] ?? 0);
	let samples = 0;
	for (let i = 0; i < packets.length;) {
		const group: Uint8Array[] = [];
		let segments = 0;
		while (i < packets.length && group.length < per) {
			const need = Math.floor(packets[i].length / 255) + 1;
			if (segments + need > 255) break;
			segments += need;
			group.push(packets[i]);
			samples += sizeOf(i);
			i++;
		}
		const last = i >= packets.length;
		// RFC 7845: the granule position counts decoded samples from the start of the stream, pre-skip included; the last
		// page is cut to pre-skip + the real length, which drops the padding the encoder added at the end
		const granule = last ? Math.min(samples, options.preSkip + options.totalSamples) : samples;
		pages.push(writePage(serial, seq++, { type: last ? 0x04 : 0x00, granule, packets: group }));
	}
	if (packets.length === 0)
		pages.push(writePage(serial, seq++, { type: 0x04, granule: options.preSkip, packets: [] }));
	const total = pages.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of pages) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
