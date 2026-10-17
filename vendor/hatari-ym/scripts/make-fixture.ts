/**
 * Build a regression fixture from a Hatari recording.
 *   node scripts/make-fixture.ts <name> <trace.txt> <reference.s16le>
 * Stores the YM write log (gzip JSON) and the SHA-256 of the audio Hatari really produced.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readTrace } from '../src/trace.ts';

const [name, tracePath, refPath] = process.argv.slice(2);
const trace = await readTrace(tracePath);
const events = trace.events.map(e => [e.clock, e.kind === 'r' ? 1 : 0, e.reg, e.value, e.vbl, e.instr]);
writeFileSync(`test/fixtures/${name}.events.json.gz`, gzipSync(JSON.stringify({ frameStart: trace.frameStart, events })));
const ref = readFileSync(refPath);
const expected = { name, samples: ref.length / 2, sha256: createHash('sha256').update(ref).digest('hex'), source: 'Hatari 2.5.0 AVI audio (left channel = right channel)' };
writeFileSync(`test/fixtures/${name}.expected.json`, JSON.stringify(expected, null, 2) + '\n');
console.log(name, events.length, 'events', expected.samples, 'samples', expected.sha256.slice(0, 16));
