import { describe, expect, it } from 'vitest';

import { EotError, EotErrorCode } from './errors';
import { readMagnitude } from './magnitude';
import { Stream } from './stream';

describe('readMagnitude', () => {
	it('reads zero and positive/negative unary magnitudes LSB first', () => {
		// 0, +1 (100), -1 (101), +2 (1100), -2 (1101), packed low bit first.
		const stream = new Stream(new Uint8Array([0b11010010, 0b01011001]), 2);
		const values = [0, 1, -1, 2, -2];
		for (const value of values) expect(readMagnitude(stream)).toBe(value);
	});

	it('throws INSUFFICIENT_BYTES for a truncated magnitude', () => {
		const stream = new Stream(new Uint8Array([0xff]), 1);
		expect(() => readMagnitude(stream)).toThrow(EotError);
		try { readMagnitude(stream); } catch (error) {
			expect((error as EotError).code).toBe(EotErrorCode.InsufficientBytes);
		}
	});
});
