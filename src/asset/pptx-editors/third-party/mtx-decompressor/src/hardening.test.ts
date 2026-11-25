import { describe, expect, it } from 'vitest';
import { EotError, EotErrorCode, toEotError } from './errors';
import { parseEotMetadata } from './eot';
import { decompressMtx, unpackMtx } from './mtx-decompress';
import { lzcompDecompress, OUTPUT_BUDGET_EXCEEDED } from './lzcomp';
import { Stream } from './stream';

describe('hardening', () => {
	it('rejects fontDataSize larger than totalSize', () => {
		const b = new Uint8Array(32);
		new DataView(b.buffer).setUint32(0, 16, true);
		new DataView(b.buffer).setUint32(4, 1000, true);
		expect(() => parseEotMetadata(b)).toThrow(EotError);
	});

	it('wraps non-EotError exceptions with a cause', () => {
		const e = toEotError(new RangeError('boom'));
		expect(e).toBeInstanceOf(EotError);
		expect(e.code).toBe(EotErrorCode.CorruptFile);
		expect(e.cause).toBeInstanceOf(RangeError);
	});

	it('only throws EotError on garbage compressed input', () => {
		const junk = new Uint8Array(64).map((_, i) => (i * 37) & 0xff);
		expect(() => decompressMtx(junk)).toThrow(EotError);
	});

	it('warns on non-sfnt uncompressed passthrough', () => {
		const warnings: string[] = [];
		decompressMtx(new Uint8Array([1, 2, 3, 4]), { compressed: false, onWarn: (m) => warnings.push(m) });
		expect(warnings).toHaveLength(1);
	});

	it('grows stream reservations geometrically', () => {
		const s = new Stream(null, 0);
		s.reserve(10);
		s.reserve(11);
		expect(s.reserved).toBeGreaterThanOrEqual(20);
	});
});

describe('maxOutputBytes', () => {
	it('rejects a font larger than the cap', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const { eotToTtf } = await import('./eot');
		const eot = new Uint8Array(readFileSync(join(__dirname, '__fixtures__', 'real', 'glyphicons-3.3.7.eot')));
		expect(() => eotToTtf(eot, { maxOutputBytes: 1000 })).toThrow(/maxOutputBytes/);
		expect(eotToTtf(eot, { maxOutputBytes: 1_000_000 }).length).toBeGreaterThan(1000);
	});

	it('rejects an oversized declared LZCOMP length before allocating for it', () => {
		// Version 1 has no RLE flag bit, so the first 24 bits are the output length.
		const declared = new Uint8Array([0x10, 0x00, 0x00, 0, 0, 0, 0, 0]); // 1 MiB
		expect(() => lzcompDecompress(declared, declared.length, 1, 1024)).toThrow(OUTPUT_BUDGET_EXCEEDED);
	});

	it('enforces the budget across the three MTX streams during unpacking', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const eot = new Uint8Array(readFileSync(join(__dirname, '__fixtures__', 'real', 'glyphicons-3.3.7.eot')));
		const meta = parseEotMetadata(eot);
		const mtx = eot.subarray(meta.fontDataOffset, meta.fontDataOffset + meta.fontDataSize);
		const total = unpackMtx(mtx, mtx.length).sizes.reduce((a, b) => a + b, 0);
		expect(unpackMtx(mtx, mtx.length, total).sizes.reduce((a, b) => a + b, 0)).toBe(total);
		expect(() => unpackMtx(mtx, mtx.length, total - 1)).toThrow(OUTPUT_BUDGET_EXCEEDED);
	});
});

describe('input types', () => {
	it('accepts ArrayBuffer, DataView and Blob', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const { eotToTtf, eotToTtfAsync } = await import('./eot');
		const raw = new Uint8Array(readFileSync(join(__dirname, '__fixtures__', 'real', 'fontawesome-3.2.1.eot')));
		const want = eotToTtf(raw);
		const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
		expect(eotToTtf(ab)).toEqual(want);
		expect(eotToTtf(new DataView(ab))).toEqual(want);
		expect(await eotToTtfAsync(new Blob([raw]))).toEqual(want);
	});
});

describe('structured warnings', () => {
	it('reports a code alongside the message', async () => {
		const { EotErrorCode: Codes } = await import('./errors');
		const seen: { code: string; message: string }[] = [];
		const plain: string[] = [];
		decompressMtx(new Uint8Array([1, 2, 3, 4]), {
			compressed: false,
			onWarn: (m) => plain.push(m),
			onWarning: (w) => seen.push(w),
		});
		expect(seen).toHaveLength(1);
		expect(seen[0].code).toBe(Codes.WarnNotSfnt);
		expect(plain).toEqual([seen[0].message]);
	});

	it('flags warning codes via EotError.isWarning', () => {
		expect(new EotError(EotErrorCode.WarnMissingTable, 'x').isWarning).toBe(true);
		expect(new EotError(EotErrorCode.CorruptFile, 'x').isWarning).toBe(false);
	});
});

describe('browser safety', () => {
	it('library sources do not reference Node-only APIs', async () => {
		const { readdirSync, readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const files = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
		for (const f of files) {
			const src = readFileSync(join(__dirname, f), 'utf8');
			expect(src, f).not.toMatch(/from ['"]node:|require\(|\bBuffer\b|\bprocess\./);
		}
	});
});
