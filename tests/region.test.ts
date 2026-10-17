import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Region, framePeriod, regionFromFrameRate } from '../src/region.ts';

test('Region follows the specification: PAL = 50 Hz, NTSC = 60 Hz', () => {
	assert.equal(Region.PAL, 50);
	assert.equal(Region.NTSC, 60);
	assert.ok(Math.abs(framePeriod(Region.PAL) - 0.02) < 1e-12);
	assert.ok(Math.abs(framePeriod(Region.NTSC) - 1 / 60) < 1e-12);
});

test('regionFromFrameRate maps real machine rates to the nearest standard', () => {
	assert.equal(regionFromFrameRate(50.124542), Region.PAL);
	assert.equal(regionFromFrameRate(59.826), Region.NTSC);
	assert.equal(regionFromFrameRate(60.0988), Region.NTSC);
});
