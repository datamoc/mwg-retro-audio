/** A Vorbis comment block (vendor string and NAME=value pairs), as used by FLAC and by Ogg Opus (after its magic) */
export function vorbisComment(vendor: string, tags: Record<string, string>): Uint8Array {
	const enc = new TextEncoder();
	const entries = Object.entries(tags).map(([k, v]) => enc.encode(`${k.toUpperCase()}=${v}`));
	const vendorBytes = enc.encode(vendor);
	let size = 4 + vendorBytes.length + 4;
	for (const e of entries) size += 4 + e.length;
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	let o = 0;
	view.setUint32(o, vendorBytes.length, true);
	o += 4;
	out.set(vendorBytes, o);
	o += vendorBytes.length;
	view.setUint32(o, entries.length, true);
	o += 4;
	for (const e of entries) {
		view.setUint32(o, e.length, true);
		o += 4;
		out.set(e, o);
		o += e.length;
	}
	return out;
}
