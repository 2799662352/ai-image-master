const POLYNOMIAL_HIGH = 0xc96c5795
const POLYNOMIAL_LOW = 0xd7870f42

const tableHigh = new Uint32Array(256)
const tableLow = new Uint32Array(256)

for (let index = 0; index < 256; index += 1) {
  let high = 0
  let low = index
  for (let bit = 0; bit < 8; bit += 1) {
    const carry = low & 1
    low = ((low >>> 1) | ((high & 1) << 31)) >>> 0
    high = (high >>> 1) >>> 0
    if (carry) {
      high = (high ^ POLYNOMIAL_HIGH) >>> 0
      low = (low ^ POLYNOMIAL_LOW) >>> 0
    }
  }
  tableHigh[index] = high
  tableLow[index] = low
}

export class Crc64Ecma182 {
  #high = 0xffffffff
  #low = 0xffffffff

  update(buffer) {
    for (const byte of buffer) {
      const index = (this.#low ^ byte) & 0xff
      const nextLow =
        (((this.#low >>> 8) | (this.#high << 24)) ^ tableLow[index]) >>> 0
      const nextHigh = ((this.#high >>> 8) ^ tableHigh[index]) >>> 0
      this.#high = nextHigh
      this.#low = nextLow
    }
    return this
  }

  digest() {
    const high = (~this.#high) >>> 0
    const low = (~this.#low) >>> 0
    return ((BigInt(high) << 32n) | BigInt(low)).toString(10)
  }
}

export function crc64Ecma182(buffer) {
  return new Crc64Ecma182().update(buffer).digest()
}
