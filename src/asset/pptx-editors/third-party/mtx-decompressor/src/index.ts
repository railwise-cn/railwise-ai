/**
 * mtx-decompressor — MicroType Express (MTX) font decompressor.
 *
 * Converts MTX-compressed font data (found inside EOT containers) back into
 * standard TrueType (.ttf) font files.
 *
 * Ported from libeot (MPL 2.0) by Brennan T. Vincent.
 * See: https://github.com/nicowilliams/libeot
 *
 * @packageDocumentation
 */

export { decompressMtx, decompressEotFont, unpackMtx, DEFAULT_MAX_OUTPUT_BYTES } from './mtx-decompress';
export type { DecompressOptions } from './mtx-decompress';
export { parseCTF } from './ctf-parser';
export { dumpContainer } from './sfnt-builder';
export { Stream } from './stream';
export type { SFNTContainer, SFNTTable, ParseCTFOptions } from './ctf-parser';
export { EotError, EotErrorCode, EOT_WARN } from './errors';
export type { EotWarning } from './errors';
export {
	parseEotMetadata,
	inspectEotProtection,
	eotToTtf,
	eotToTtfAsync,
	canLegallyEdit,
	TTEMBED_SUBSET,
	TTEMBED_TTCOMPRESSED,
	TTEMBED_XORENCRYPTDATA,
} from './eot';
export type { EotMetadata, EotVersion, EotProtection, BinaryInput, BlobLike, EotToTtfOptions } from './eot';
