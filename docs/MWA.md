# MWA: the universal retro audio container

MWA ("MW Audio") is the one file format this engine needs to play any music or sound effect of the retro machines it
emulates. It is deliberately small:

- **a register log**: what the original software wrote to the sound chips, with the time of each write. Every
  source format (YM, VGM, NSF, SID, DRO, IMF, CMF, a recording of a PC speaker...) is such a log in disguise, so
  converting to MWA loses nothing;
- **compressed with DEFLATE**, the format of zip and gzip, decoded by a 150 line function of this package
  (`inflateRaw`) and written with the platform's native `CompressionStream('deflate-raw')`: **no external
  dependency**, and a stored-block fallback where the platform has none;
- **self describing**: chips, clocks and options travel in the file, so playing it needs no other information.

Sample based formats (MOD, XM, IT, WAV, VOC) are not register logs: they stay as they are, the engine plays them
directly.

## Layout

All numbers little endian. `varint` is the LEB128 of Protocol Buffers: 7 bits per byte, low bits first, bit 7 =
"more".

```
offset  size  field
0       4     magic "MWA1"
4       1     flags: bit 0 = payload is DEFLATE (raw) compressed; 0 = stored as is
5       4     payload size once decompressed (uint32)
9       ...   payload (DEFLATE stream, or raw bytes when bit 0 is clear)
```

Payload (after decompression):

```
float64   timebase      ticks per second of the event times (default 44100)
float64   frameRate     frames per second of the original player: 50, 60, 50.1245 (C64 PAL)...
string    title         varint length + UTF-8
string    author
string    comment
varint    chipCount
  per chip:
    string   id         registry id: ym2149, ay8910, sn76489, nes-apu, sid, opl2, opl3, ym2612, ym2151,
                        pc-speaker, saa1099, pcm-dac, cms, sound-blaster, tandy
    float64  clock      master clock in Hz
    string   options    JSON object of constructor options, "" when none (e.g. {"variant":"sega"})
varint    blobCount
  per blob:  varint chip, varint address, varint length, bytes   (memory image: NES DPCM samples at $C000..)
varint    length        total length in ticks (silence after the last write is part of it)
varint    loopStart + 1 loop start in ticks, 0 = no loop
varint    eventCount
  per event:
    varint   delta      ticks since the previous event
    uint8    chip       index in the chip list
    varint   address    register / port address, as the chip defines it
    uint8    value
```

`address` keeps the meaning it has on the real chip: the 0-15 registers of the YM2149, the single data port of the
SN76489 (any address), `0x4000 + n` or `n` for the NES APU, `0x100 | reg` for the second bank of an OPL3 or the
second port of a YM2612, the ISA port (0x220...) for the `cms` and `sound-blaster` cards, the PIT / system port
(0x42, 0x43, 0x61) for the `pc-speaker`.

## Time

An event takes effect at sample `round(time * sampleRate / timebase)` of the output. The engine renders the chips
up to that sample, performs the write, and goes on: register changes inside a frame (SID voice, digidrums, 1 bit
PWM on the PC speaker) are reproduced to the sample. With the default timebase of 44100 an event is accurate to one
sample at CD rate; use a larger timebase to keep more precision for a high rate output.

## Producing and consuming

```ts
import { convertToMwa, loadFile, MwaPlayer, decodeMwa } from '@datamoc/mwg-retro-audio/formats';

const mwa = await convertToMwa(ymBytes); // any register driven file -> MWA
const player = loadFile(mwa, { sampleRate }); // or new MwaPlayer(decodeMwa(mwa), { sampleRate })
```

`MwaRecorder` records the writes of any player built with its chip factory (that is what `convertToMwa` does), so a
new format only has to be a player to become convertible. `encodeMwaUncompressed` writes the same file with stored
blocks, readable even without a native compressor.

## Properties checked by the tests

- a YM converted to MWA plays back **bit for bit** the audio of the YM (`tests/formats.test.ts`);
- compressed and stored encodings decode to identical data; the loop point and the metadata are kept;
- an MWA written for an `ay8910` keeps its clock and model;
- corrupt data raises an error, it never loops.

## Why not a standard format

VGM is the closest (a timed log with several chips), and its data can be mapped to MWA one for one; MWA differs
by being **a single self contained and compressed file** with the chip options inside, free of the ageing details of
VGM (command numbers per chip, offsets relative to different fields), and by covering chips VGM never had a command
for (PC speaker, C/MS, Sound Blaster DSP, YM2151 ports...). See `MWL-PROPOSAL.md` for how MWA files fit in the
mwg content language.
