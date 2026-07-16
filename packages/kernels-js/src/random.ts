/**
 * xoshiro128** with SplitMix32 state expansion. All operations are explicit
 * uint32 arithmetic, so a seed produces identical starts in Node and browsers.
 */
export class Xoshiro128StarStar {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let state = seed >>> 0;
    const nextSeed = (): number => {
      state = (state + 0x9e3779b9) >>> 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = nextSeed();
    this.s1 = nextSeed();
    this.s2 = nextSeed();
    this.s3 = nextSeed();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  nextUint32(): number {
    const result = Math.imul(rotateLeft(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const temporary = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ temporary) >>> 0;
    this.s3 = rotateLeft(this.s3, 11);
    return result;
  }

  next(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  between(lower: number, upper: number): number {
    return lower + (upper - lower) * this.next();
  }
}

/** Derives independent deterministic start seeds without depending on call order. */
export function deriveStartSeed(seed: number, startIndex: number): number {
  let value = (seed + Math.imul(startIndex + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function rotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}
