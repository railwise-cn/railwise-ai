import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EotError, EotErrorCode } from './errors';
import { lzcompDecompress } from './lzcomp';

/**
 * Real LZCOMP bitstreams depend on adaptive Huffman state, so these tests
 * replace the Huffman decoder with one that replays scripted symbols. That
 * lets us drive the decoder's own bounds checks directly. Construction order in
 * `lzcompDecompress` is: distance tree, length tree, symbol tree.
 */
const state = vi.hoisted(() => ({
	scripts: [] as number[][],
	made: 0,
}));

vi.mock('./ahuff', () => ({
	AHuff: class {
		private queue: number[];
		constructor() {
			this.queue = [...(state.scripts[state.made++] ?? [])];
		}
		readSymbol(): number {
			const next = this.queue.shift();
			if (next === undefined) {
				throw new Error('scripted symbols exhausted');
			}
			return next;
		}
	},
}));

/** Bytes holding a 24-bit big-endian `outLen` (version 1: no RLE flag bit). */
function header24(outLen: number): Uint8Array {
	return new Uint8Array([(outLen >> 16) & 0xff, (outLen >> 8) & 0xff, outLen & 0xff]);
}

/** Bytes holding the RLE flag bit (1) followed by a 24-bit `outLen`. */
function headerRle(outLen: number): Uint8Array {
	const bits = (1 << 24) | outLen; // 25 bits
	const shifted = bits * 2 ** 7; // left-align into 32 bits
	return new Uint8Array([
		Math.floor(shifted / 2 ** 24) & 0xff,
		Math.floor(shifted / 2 ** 16) & 0xff,
		Math.floor(shifted / 2 ** 8) & 0xff,
		shifted & 0xff,
	]);
}

describe('lzcompDecompress guards', () => {
	beforeEach(() => {
		state.made = 0;
		state.scripts = [];
	});

	it('rejects a back-reference that reaches before the start of the window', () => {
		// outLen 20000 needs 5 distance chunks; symbol 288 = copy with 5 chunks,
		// length chunk 0 (length 2). Distance 7,7,7,7,7 -> 32768 > preload + pos.
		state.scripts = [[7, 7, 7, 7, 7], [], [65, 288]];
		try {
			lzcompDecompress(header24(20000), 3, 1);
			expect.fail('expected the out-of-window match to be rejected');
		} catch (error) {
			expect(error).toBeInstanceOf(EotError);
			expect((error as EotError).code).toBe(EotErrorCode.MtxError);
			expect((error as EotError).message).toMatch(/before the start of the window/);
		}
	});

	it('rejects the same out-of-window match on the run-length path', () => {
		state.scripts = [[7, 7, 7, 7, 7], [], [65, 288]];
		expect(() => lzcompDecompress(headerRle(20000), 4, 2)).toThrow(/before the start of the window/);
	});

	it('rejects run-length data that ends inside an escape sequence', () => {
		// First byte is the escape sentinel; the second equals it, opening an
		// escape that never receives its count.
		state.scripts = [[], [], [0xaa, 0xaa]];
		try {
			lzcompDecompress(headerRle(2), 4, 2);
			expect.fail('expected a dangling escape to be rejected');
		} catch (error) {
			expect(error).toBeInstanceOf(EotError);
			expect((error as EotError).code).toBe(EotErrorCode.MtxError);
			expect((error as EotError).message).toMatch(/escape sequence/);
		}
	});

	it('still decodes a well-formed run-length stream', () => {
		// escape 0xAA, literal 1, escaped escape (AA 00)
		state.scripts = [[], [], [0xaa, 1, 0xaa, 0]];
		expect([...lzcompDecompress(headerRle(4), 4, 2)]).toEqual([1, 0xaa]);
	});
});
