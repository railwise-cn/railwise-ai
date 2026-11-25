/**
 * Top-level MicroType Express (MTX) decompression pipeline.
 * Ported from libeot (MPL 2.0) — writeFontFile.c / liblzcomp.c
 *
 * Combines LZ decompression, CTF parsing, and SFNT assembly to
 * produce a usable TrueType font from compressed MTX / EOT data.
 */

import { parseCTF } from './ctf-parser';
import { lzcompDecompress, OUTPUT_BUDGET_EXCEEDED } from './lzcomp';
import { dumpContainer } from './sfnt-builder';
import { Stream } from './stream';
import { EotError, EotErrorCode, emitWarning, toEotError, type EotWarning } from './errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** XOR key used for MTX encryption. */
const ENCRYPTION_KEY = 0x50;

// ---------------------------------------------------------------------------
// MTX unpacking (3-stream decompression)
// ---------------------------------------------------------------------------

/**
 * Unpack an MTX blob into three LZCOMP-decompressed streams.
 *
 * MTX header layout (10 bytes, big-endian):
 *   byte  0     : versionMagic
 *   bytes 1–3   : copyLimit  (24-bit BE, informational only)
 *   bytes 4–6   : offset2    (24-bit BE)
 *   bytes 7–9   : offset3    (24-bit BE)
 *
 * The data following the header is split into three contiguous
 * compressed blocks whose boundaries are determined by the offsets.
 *
 * @param data  Raw MTX data, i.e. the font-data region of the EOT container.
 *              Real-world EOT files (Glyphicons, Font Awesome) decode as-is;
 *              no BSGP stripping is needed.
 * @param size  Total byte length of `data`.
 * @param maxOutputBytes  Optional combined budget for the three decompressed
 *              streams. Each stream is decoded against what is left of it,
 *              so an oversized stream fails before its buffers are allocated.
 * @returns An object containing the three decompressed byte arrays and
 *          their respective sizes.
 */
export function unpackMtx(
	data: Uint8Array,
	size: number,
	maxOutputBytes: number = Infinity,
): { streams: Uint8Array[]; sizes: number[] } {
	// --- Validate buffer & header ------------------------------------------
	if (data.length < 10) {
		throw new EotError(EotErrorCode.InsufficientBytes, 'MTX data too small: header requires at least 10 bytes');
	}
	if (!Number.isInteger(size)) {
		throw new EotError(
			EotErrorCode.MtxError,
			`MTX data size must be an integer: size=${size}`,
		);
	}
	if (size < 10) {
		throw new EotError(EotErrorCode.InsufficientBytes, 'MTX data too small: header requires at least 10 bytes');
	}
	if (size > data.length) {
		throw new EotError(
			EotErrorCode.InsufficientBytes,
			`MTX data size exceeds the input buffer: size=${size}, data.length=${data.length}`,
		);
	}

	// --- Read 10-byte MTX header -------------------------------------------
	const versionMagic = data[0];

	// 24-bit big-endian reads
	// const copyLimit = (data[1] << 16) | (data[2] << 8) | data[3]; // not used
	const offset2 = (data[4] << 16) | (data[5] << 8) | data[6];
	const offset3 = (data[7] << 16) | (data[8] << 8) | data[9];

	// Validate offset ordering: 10 <= offset2 <= offset3 <= size
	if (offset2 < 10 || offset3 < offset2 || offset3 > size) {
		throw new EotError(
			EotErrorCode.MtxError,
			`MTX header offsets out of bounds: offset2=${offset2}, offset3=${offset3}, size=${size}`,
		);
	}

	// Block boundaries — clamp blockSizes to >= 0 defensively
	const offsets = [10, offset2, offset3];
	const blockSizes = [
		Math.max(0, offset2 - 10),
		Math.max(0, offset3 - offset2),
		Math.max(0, size - offset3),
	];

	// Decompress each block
	const streams: Uint8Array[] = [];
	const decompressedSizes: number[] = [];
	let budget = maxOutputBytes;

	for (let i = 0; i < 3; i++) {
		const block = data.subarray(offsets[i], offsets[i] + blockSizes[i]);
		const decompressed = lzcompDecompress(block, blockSizes[i], versionMagic, budget);
		budget -= decompressed.length;
		streams.push(decompressed);
		decompressedSizes.push(decompressed.length);
	}

	return { streams, sizes: decompressedSizes };
}

// ---------------------------------------------------------------------------
// Main decompression entry point
// ---------------------------------------------------------------------------

/** Default ceiling on the size of a reconstructed font (128 MiB). */
export const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

/** Options accepted by {@link decompressMtx}. */
export interface DecompressOptions {
	encrypted?: boolean;
	compressed?: boolean;
	onWarn?: (message: string) => void;
	/** Structured variant of {@link onWarn}: receives `{ code, message }`. */
	onWarning?: (warning: EotWarning) => void;
	/**
	 * Upper bound on the reconstructed font size in bytes, guarding against
	 * decompression bombs. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}; pass
	 * `Infinity` to disable.
	 */
	maxOutputBytes?: number;
}

/**
 * Decompress an MTX-compressed font (e.g. from an EOT wrapper) into a
 * standard sfnt font binary (TrueType, or OpenType/CFF).
 *
 * @param fontData    Raw font bytes (MTX-compressed, optionally encrypted).
 * @param options.encrypted   If `true`, XOR-decrypt with {@link ENCRYPTION_KEY}.
 * @param options.compressed  If `false`, skip decompression and return the
 *                            (possibly decrypted) data as-is.
 * @param options.maxOutputBytes  Cap on the reconstructed font size.
 * @param options.onWarn      Optional hook invoked with a message for each
 *                            non-fatal diagnostic. The font is still produced.
 * @returns A `Uint8Array` containing a valid sfnt font: TrueType, or OpenType/CFF (`OTTO`).
 */
export function decompressMtx(
	fontData: Uint8Array,
	options?: DecompressOptions,
): Uint8Array {
	try {
		return decompressMtxUnchecked(fontData, options);
	} catch (err) {
		throw toEotError(err);
	}
}

function decompressMtxUnchecked(
	fontData: Uint8Array,
	options?: DecompressOptions,
): Uint8Array {
	const encrypted = options?.encrypted ?? false;
	const compressed = options?.compressed ?? true;

	// --- Decryption --------------------------------------------------------
	let data: Uint8Array;
	if (encrypted) {
		data = new Uint8Array(fontData.length);
		for (let i = 0; i < fontData.length; i++) {
			data[i] = fontData[i] ^ ENCRYPTION_KEY;
		}
	} else {
		// Alias the caller's buffer — the decompression path only reads from it,
		// never writes. (On the uncompressed passthrough below we hand back an
		// owned copy so the caller's array is never returned as our output.)
		data = fontData;
	}

	// --- Early exit when not compressed ------------------------------------
	if (!compressed) {
		const tag = data.length >= 4 ? ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0 : 0;
		// 0x00010000, 'OTTO', 'true', 'ttcf'
		if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565 && tag !== 0x74746366) {
			emitWarning(
				options,
				EotErrorCode.WarnNotSfnt,
				'uncompressed font data does not start with a recognised sfnt signature',
			);
		}
		// Return an owned buffer, matching libeot (writeFontFile.c always copies).
		// The encrypted branch already allocated a fresh array; the aliased
		// branch must be copied so we never return the caller's own buffer.
		return encrypted ? data : data.slice();
	}

	// --- Unpack 3 LZCOMP streams ------------------------------------------
	const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	let streams: Uint8Array[];
	try {
		({ streams } = unpackMtx(data, data.length, maxOutputBytes));
	} catch (err) {
		if (err instanceof EotError && err.message.startsWith(OUTPUT_BUDGET_EXCEEDED)) {
			throw new EotError(EotErrorCode.MtxError, `decompressed streams exceed maxOutputBytes (${maxOutputBytes})`);
		}
		throw err;
	}

	// --- Wrap each decompressed buffer in a Stream -------------------------
	const streamObjects = streams.map((buf) => new Stream(buf, buf.length));

	// --- Parse CTF structure -----------------------------------------------
	const container = parseCTF(streamObjects, { onWarn: options?.onWarn, onWarning: options?.onWarning });

	// --- Assemble final TrueType font -------------------------------------
	return dumpContainer(container, { maxOutputBytes });
}

// ---------------------------------------------------------------------------
// Convenience wrapper (explicit boolean parameters)
// ---------------------------------------------------------------------------

/**
 * Decompress an EOT-embedded font.
 *
 * This is a thin wrapper around {@link decompressMtx} that accepts explicit
 * boolean parameters instead of an options object.
 *
 * @param fontData    Raw font bytes extracted from the EOT container.
 * @param compressed  Whether the data is MTX-compressed.
 * @param encrypted   Whether the data is XOR-encrypted.
 * @returns A `Uint8Array` containing a valid sfnt font: TrueType, or OpenType/CFF (`OTTO`).
 */
export function decompressEotFont(
	fontData: Uint8Array,
	compressed: boolean,
	encrypted: boolean,
): Uint8Array {
	return decompressMtx(fontData, { encrypted, compressed });
}
