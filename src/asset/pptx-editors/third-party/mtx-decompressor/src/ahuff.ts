/**
 * Adaptive Huffman coder using a splay-tree that maintains the sibling
 * property (nodes ordered by non-increasing weight).
 *
 * Ported from libeot (MPL 2.0) MTX_AHUFF implementation.
 *
 * Tree layout (1-indexed):
 *   - ROOT          = 1
 *   - Internal nodes = 1 .. range-1
 *   - Leaf nodes     = range .. 2*range-1
 *   - Leaf at index (range + i) encodes symbol i  (0 <= i < range)
 *
 * The tree is initialised as a perfect / near-perfect binary tree and
 * then optionally pre-biased depending on the symbol range.
 */
import { BitIO } from './bitio';
import { EotError, EotErrorCode } from './errors';

/**
 * Return the number of bits required to represent the non-negative integer `x`.
 * Equivalent to floor(log2(x)) + 1 for x > 0.
 *
 * libeot's `BitsUsed(0)` returns 1 (its mask cascade falls through to the low
 * bit); we match that so the function is a faithful port. In practice this
 * module only ever calls it with x > 0, so the zero case is defensive.
 */
function bitsUsed(x: number): number {
	if (x <= 0) {
		return 1;
	}
	return 32 - Math.clz32(x);
}

export class AHuff {
	private bio: BitIO;
	private range: number;
	// Tree stored as parallel typed arrays (1-indexed, index 0 unused):
	//   up     parent index (position-specific, never swapped)
	//   child  child indices, interleaved: child[2a] is the left (bit 0) and
	//          child[2a + 1] the right (bit 1) child of node a; -1 for leaves.
	//          Interleaving lets readSymbol index by the decoded bit instead of
	//          branching on it — compressed bits are close to random, so a
	//          `bit ? right : left` branch mispredicts about half the time.
	//   code   symbol for leaves (>= 0), -1 for internal nodes
	//   weight cumulative weight maintaining the sibling property
	private up: Int32Array;
	private child: Int32Array;
	private code: Int32Array;
	private weight: Int32Array;
	/** Maps symbol value -> current tree index of its leaf node. */
	private symbolIndex: Int32Array;

	/** Number of bits that encode a "full-size" symbol (ceil(log2(range))). */
	private bitCount: number;
	/**
	 * Secondary bit width used for large-range trees.
	 * 0 when range <= 256 (small tree path).
	 */
	private bitCount2: number;

	private static readonly ROOT = 1;

	constructor(bio: BitIO, range: number) {
		this.bio = bio;
		this.range = range;

		// Derive bit widths --------------------------------------------------
		// Matches C: bitCount2 is non-zero only for range 257..511
		this.bitCount = bitsUsed(range - 1);
		this.bitCount2 = 0;
		if (range > 256 && range < 512) {
			this.bitCount2 = bitsUsed(range - 256 - 1) + 1;
		}

		const treeSize = 2 * range; // indices 0 .. 2*range-1

		// Allocate the tree (index 0 is an unused sentinel) ------------------
		const up = (this.up = new Int32Array(treeSize));
		const child = (this.child = new Int32Array(2 * treeSize));
		const code = (this.code = new Int32Array(treeSize).fill(-1));
		this.weight = new Int32Array(treeSize);

		// Parent pointers; weight = 1 for all non-root nodes (matching the C code
		// which initializes weight=1 for i in 2..limit-1)
		for (let i = 2; i < treeSize; i++) {
			up[i] = i >> 1;
			this.weight[i] = 1;
		}

		// Internal nodes (1 .. range-1): set children, code = -1
		for (let i = 1; i < range; i++) {
			child[2 * i] = 2 * i;
			child[2 * i + 1] = 2 * i + 1;
		}

		// Leaf nodes (range .. 2*range-1): code = symbol index. The C code sets
		// left=-1, right=-1 for leaves.
		this.symbolIndex = new Int32Array(range);
		for (let i = 0; i < range; i++) {
			const leafIdx = range + i;
			code[leafIdx] = i;
			child[2 * leafIdx] = -1;
			child[2 * leafIdx + 1] = -1;
			this.symbolIndex[i] = leafIdx;
		}

		// Compute internal node weights bottom-up ----------------------------
		this.initWeight(AHuff.ROOT);

		// Pre-bias weights depending on tree size ----------------------------
		if (this.bitCount2 !== 0) {
			// Large tree (range > 256): bias specific control symbols
			this.updateWeight(this.symbolIndex[256]);
			this.updateWeight(this.symbolIndex[257]);

			// DUP2 symbol = range - 3: 12 extra weight bumps
			const dup2Sym = range - 3;
			for (let i = 0; i < 12; i++) {
				this.updateWeight(this.symbolIndex[dup2Sym]);
			}

			// DUP4 symbol = range - 2: 6 extra weight bumps
			const dup4Sym = range - 2;
			for (let i = 0; i < 6; i++) {
				this.updateWeight(this.symbolIndex[dup4Sym]);
			}
		} else {
			// Small tree (range <= 256): update every symbol twice
			for (let j = 0; j < 2; j++) {
				for (let i = 0; i < range; i++) {
					this.updateWeight(this.symbolIndex[i]);
				}
			}
		}
	}

	// --------------------------------------------------------------------
	// Public API
	// --------------------------------------------------------------------

	/**
	 * Decode one symbol from the bit stream.
	 *
	 * Starting at ROOT, read one bit at a time:
	 *   - 0 → go left
	 *   - 1 → go right
	 * Continue until a leaf (code >= 0) is reached.  Then update the
	 * tree weights and return the symbol code.
	 */
	readSymbol(): number {
		const bio = this.bio;
		const code = this.code;
		const child = this.child;
		let a = AHuff.ROOT;
		let symbol: number;

		// Bit reads are inlined (equivalent to `bio.nextBit()`) with the reader
		// state held in locals and written back once: this loop dominates
		// decompression time.
		const data = bio.data;
		const size = bio.size;
		let index = bio.index;
		let byte = bio.bitBuffer;
		let count = bio.bitCount;

		// Traverse tree from ROOT to leaf (matches C do-while)
		do {
			if (count === 0) {
				if (index >= size) {
					bio.index = index;
					bio.bitBuffer = byte;
					bio.bitCount = 0;
					throw new EotError(EotErrorCode.InsufficientBytes, 'BitIO: end of data');
				}
				byte = data[index++];
				count = 8;
			}
			a = child[(a << 1) | ((byte >> --count) & 1)];
			symbol = code[a];
		} while (symbol < 0);

		bio.index = index;
		bio.bitBuffer = byte;
		bio.bitCount = count;

		// Update adaptive weights for the decoded leaf
		this.updateWeight(a);

		return symbol;
	}

	// --------------------------------------------------------------------
	// Private helpers
	// --------------------------------------------------------------------

	/**
	 * Increment the weight of node `a` and propagate up to ROOT, swapping
	 * nodes as necessary to maintain the sibling property (nodes in
	 * non-increasing weight order by index). For each node below ROOT: if its
	 * predecessor has the same weight, scan back to the first node with that
	 * weight and swap with it (unless that is ROOT), then bump the weight and
	 * move to the parent. Finally ROOT's weight is incremented.
	 */
	private updateWeight(a: number): void {
		const weight = this.weight;
		const up = this.up;

		for (; a !== AHuff.ROOT; a = up[a]) {
			const weightA = weight[a];
			let b = a - 1;

			// C reference: scan backward while weight[b] == weightA, then b++ to
			// land on the first node with that weight.
			if (weight[b] === weightA) {
				do {
					b--;
				} while (weight[b] === weightA);
				b++;
				if (b > AHuff.ROOT) {
					this.swapNodes(a, b);
					a = b;
				}
			}

			weight[a] = weightA + 1;
		}

		// Increment ROOT weight
		weight[AHuff.ROOT]++;
	}

	/**
	 * Swap the content (children, code, weight) of two nodes. The `up`
	 * pointer stays with the position, so afterwards the children of each
	 * swapped internal node get their parent pointer fixed, and leaves get
	 * their `symbolIndex` entry updated.
	 */
	private swapNodes(a: number, b: number): void {
		const { child, code, weight, up } = this;
		const a2 = a << 1;
		const b2 = b << 1;

		let t = child[a2];
		child[a2] = child[b2];
		child[b2] = t;
		t = child[a2 + 1];
		child[a2 + 1] = child[b2 + 1];
		child[b2 + 1] = t;
		t = code[a];
		code[a] = code[b];
		code[b] = t;
		t = weight[a];
		weight[a] = weight[b];
		weight[b] = t;

		let c = code[a];
		if (c < 0) {
			up[child[a2]] = a;
			up[child[a2 + 1]] = a;
		} else {
			this.symbolIndex[c] = a;
		}

		c = code[b];
		if (c < 0) {
			up[child[b2]] = b;
			up[child[b2 + 1]] = b;
		} else {
			this.symbolIndex[c] = b;
		}
	}

	/**
	 * Recursively compute weights for internal nodes after the initial
	 * tree construction.  Leaf weights are already set to 1.
	 *
	 * weight(internal) = weight(left) + weight(right)
	 */
	private initWeight(a: number): number {
		if (this.code[a] >= 0) {
			// Leaf — weight is already 1
			return this.weight[a];
		}
		return (this.weight[a] = this.initWeight(this.child[2 * a]) + this.initWeight(this.child[2 * a + 1]));
	}
}
