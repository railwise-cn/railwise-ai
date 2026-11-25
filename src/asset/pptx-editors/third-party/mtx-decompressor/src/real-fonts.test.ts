import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eotToTtf, inspectEotProtection, parseEotMetadata } from './index';

const dir = join(__dirname, '__fixtures__', 'real');
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(join(dir, name)));

type Tables = Map<string, Uint8Array>;

function readTables(b: Uint8Array): Tables {
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const m: Tables = new Map();
	for (let i = 0; i < dv.getUint16(4); i++) {
		const o = 12 + 16 * i;
		const tag = String.fromCharCode(...b.subarray(o, o + 4));
		const off = dv.getUint32(o + 8);
		m.set(tag, b.subarray(off, off + dv.getUint32(o + 12)));
	}
	return m;
}

function glyphOffsets(t: Tables): number[] {
	const head = t.get('head')!;
	const long = new DataView(head.buffer, head.byteOffset).getInt16(50) !== 0;
	const loca = t.get('loca')!;
	const dv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
	const n = long ? loca.length / 4 : loca.length / 2;
	return Array.from({ length: n }, (_, i) => (long ? dv.getUint32(i * 4) : dv.getUint16(i * 2) * 2));
}

interface Glyph {
	bbox: number[];
	rest: unknown;
	xs: number[];
	ys: number[];
}

/** Decode a glyph into bbox + everything else, so encoding differences don't matter. */
function parseGlyph(g: Uint8Array): Glyph | null {
	if (g.length === 0) return null;
	const dv = new DataView(g.buffer, g.byteOffset, g.length);
	const nc = dv.getInt16(0);
	const bbox = [dv.getInt16(2), dv.getInt16(4), dv.getInt16(6), dv.getInt16(8)];
	if (nc < 0) {
		let e = g.length;
		while (e > 10 && g[e - 1] === 0) e--;
		return { bbox, rest: [...g.subarray(10, e)], xs: [], ys: [] };
	}
	let p = 10;
	const ends: number[] = [];
	for (let i = 0; i < nc; i++, p += 2) ends.push(dv.getUint16(p));
	const n = nc ? ends[nc - 1] + 1 : 0;
	const il = dv.getUint16(p);
	p += 2;
	const ins = [...g.subarray(p, p + il)];
	p += il;
	const fl: number[] = [];
	while (fl.length < n) {
		const f = g[p++];
		fl.push(f);
		if (f & 8) for (let r = g[p++]; r > 0; r--) fl.push(f);
	}
	const read = (short: number, same: number): number[] => {
		const v: number[] = [];
		let c = 0;
		for (let i = 0; i < n; i++) {
			const f = fl[i];
			if (f & short) c += f & same ? g[p++] : -g[p++];
			else if (!(f & same)) {
				c += dv.getInt16(p);
				p += 2;
			}
			v.push(c);
		}
		return v;
	};
	const xs = read(2, 16);
	const ys = read(4, 32);
	return { bbox, rest: [nc, ends, ins, xs, ys, fl.map((f) => f & 1)], xs, ys };
}

function sfntChecksum(b: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < b.length; i += 4) {
		sum = (sum + (((b[i] << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0)) >>> 0;
	}
	return sum;
}

describe('real-world MTX-compressed EOT fonts', () => {
	// Glyphicons Halflings (Bootstrap 3.3.7) and Font Awesome 3.2.1 ship as
	// MTX-compressed EOT next to the original TTF they were generated from.
	for (const name of ['glyphicons-3.3.7', 'fontawesome-3.2.1']) {
		describe(name, () => {
			const eot = load(`${name}.eot`);
			const ref = readTables(load(`${name}.ttf`));
			const warnings: string[] = [];
			const out = eotToTtf(eot, { onWarn: (m) => warnings.push(m) });
			const got = readTables(out);

			it('is detected as compressed and not encrypted', () => {
				const meta = parseEotMetadata(eot);
				expect(meta.compressed).toBe(true);
				expect(meta.encrypted).toBe(false);
				expect(inspectEotProtection(eot).encryption).toBe('none');
			});

			it('decodes without warnings into a checksum-valid sfnt', () => {
				expect(warnings).toEqual([]);
				expect(sfntChecksum(out)).toBe(0xb1b0afba);
			});

			it('reproduces the unmodified tables byte-for-byte', () => {
				for (const tag of ['OS/2', 'cmap', 'cvt ', 'gasp', 'hhea', 'hmtx', 'maxp', 'post']) {
					if (!ref.has(tag)) continue;
					expect(got.get(tag), tag).toEqual(ref.get(tag));
				}
			});

			it('reproduces every glyph (contours, points, instructions)', () => {
				const a = glyphOffsets(got);
				const r = glyphOffsets(ref);
				expect(a.length).toBe(r.length);
				for (let g = 0; g < a.length - 1; g++) {
					const x = parseGlyph(got.get('glyf')!.subarray(a[g], a[g + 1]));
					const y = parseGlyph(ref.get('glyf')!.subarray(r[g], r[g + 1]));
					expect(x === null, `glyph ${g} emptiness`).toBe(y === null);
					if (x && y) expect(x.rest, `glyph ${g}`).toEqual(y.rest);
				}
			});

			it('recomputes glyph bounding boxes from the outline points', () => {
				const a = glyphOffsets(got);
				for (let g = 0; g < a.length - 1; g++) {
					const x = parseGlyph(got.get('glyf')!.subarray(a[g], a[g + 1]));
					if (!x || !x.xs.length) continue;
					expect(x.bbox, `glyph ${g}`).toEqual([
						Math.min(...x.xs),
						Math.min(...x.ys),
						Math.max(...x.xs),
						Math.max(...x.ys),
					]);
				}
			});
		});
	}
});

describe('real-world uncompressed EOT', () => {
	it('passes Font Awesome 4.7.0 through unchanged', () => {
		const eot = load('fontawesome-4.7.0.eot');
		expect(parseEotMetadata(eot).compressed).toBe(false);
		expect(eotToTtf(eot)).toEqual(load('fontawesome-4.7.0.ttf'));
	});
});
