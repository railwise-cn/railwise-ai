/**
 * Structured error type for the MTX/EOT decoder.
 *
 * Mirrors libeot's `enum EOTError` (MPL 2.0 — inc/libeot/EOTError.h) so that
 * failures are machine-discriminable via a stable `code` rather than only a
 * human-readable message. Codes at or above {@link EOT_WARN} denote recoverable
 * warnings ("the font is usable, but…") as opposed to fatal errors.
 */

/** Threshold at or above which a code is a non-fatal warning. */
export const EOT_WARN = 1000;

/** Discriminable error/warning codes, mirroring libeot's `enum EOTError`. */
export enum EotErrorCode {
	InsufficientBytes = 'INSUFFICIENT_BYTES',
	HeaderTooBig = 'HEADER_TOO_BIG',
	BogusStringSize = 'BOGUS_STRING_SIZE',
	CorruptFile = 'CORRUPT_FILE',
	LogicError = 'LOGIC_ERROR',
	NoMaxpTable = 'NO_MAXP_TABLE',
	NoHeadTable = 'NO_HEAD_TABLE',
	NoHmtxTable = 'NO_HMTX_TABLE',
	CorruptHopcodeData = 'CORRUPT_HOPCODE_DATA',
	MalformedHeadTable = 'MALFORMED_HEAD_TABLE',
	/** A byte-level read/write/seek was attempted while mid-byte (`bitPos != 0`). */
	OffByteBoundary = 'OFF_BYTE_BOUNDARY',
	/** A write or copy would exceed the stream's reserved capacity. */
	OutOfReservedSpace = 'OUT_OF_RESERVED_SPACE',
	/** A seek would move past the stream's reserved end. */
	SeekPastEos = 'SEEK_PAST_EOS',
	MtxError = 'MTX_ERROR',
	/** Recoverable: the coded version was wrong but a retry succeeded. */
	WarnBadVersion = 'WARN_BAD_VERSION',
	/** Recoverable: uncompressed font data lacks a recognised sfnt signature. */
	WarnNotSfnt = 'WARN_NOT_SFNT',
	/** Recoverable: `maxp` is not version 1.0 (TrueType). */
	WarnMaxpVersion = 'WARN_MAXP_VERSION',
	/** Recoverable: a recommended table is absent from the font. */
	WarnMissingTable = 'WARN_MISSING_TABLE',
}

/** Numeric tier per code — warnings sort at/above {@link EOT_WARN}. */
const WARNING_CODES = new Set<EotErrorCode>([
	EotErrorCode.WarnBadVersion,
	EotErrorCode.WarnNotSfnt,
	EotErrorCode.WarnMaxpVersion,
	EotErrorCode.WarnMissingTable,
]);

/** An error (or warning) raised while decoding MTX/EOT font data. */
export class EotError extends Error {
	readonly code: EotErrorCode;

	constructor(code: EotErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'EotError';
		this.code = code;
		// Preserve the prototype chain when targeting ES5-ish transpiles.
		Object.setPrototypeOf(this, EotError.prototype);
	}

	/** True when this represents a recoverable warning rather than a fatal error. */
	get isWarning(): boolean {
		return WARNING_CODES.has(this.code);
	}
}

/** Rethrow anything that is not an {@link EotError} as a `CorruptFile` EotError, keeping the cause. */
export function toEotError(err: unknown): EotError {
	if (err instanceof EotError) {
		return err;
	}
	const detail = err instanceof Error ? err.message : String(err);
	return new EotError(EotErrorCode.CorruptFile, `malformed font data: ${detail}`, { cause: err });
}

/** A recoverable diagnostic: the font was still produced. */
export interface EotWarning {
	code: EotErrorCode;
	message: string;
}

/** Warning sinks accepted by the public API. */
export interface WarnSinks {
	/** Receives the message only. */
	onWarn?: (message: string) => void;
	/** Receives a machine-readable code plus the message. */
	onWarning?: (warning: EotWarning) => void;
}

/** Dispatch a warning to whichever sinks are set. */
export function emitWarning(sinks: WarnSinks | undefined, code: EotErrorCode, message: string): void {
	sinks?.onWarn?.(message);
	sinks?.onWarning?.({ code, message });
}
