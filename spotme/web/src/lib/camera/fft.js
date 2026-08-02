/**
 * Spot Me camera — radix-2 FFT, written here because phase correlation
 * needs one and the engine ships zero dependencies.
 *
 * Iterative in-place Cooley–Tukey with bit-reversal permutation; 2D as rows
 * then columns. Sizes must be powers of two — the aligner downsamples to a
 * pow2 tile before calling, so this is an internal contract, asserted not
 * padded. Inverse carries the 1/N scaling so fft→ifft round-trips exactly
 * (to float precision), which the tests pin.
 */

export function isPow2 (n) {
  return n > 0 && (n & (n - 1)) === 0
}

/** In-place 1D FFT over interleaved-separate re/im Float32Arrays. */
export function fft1d (re, im, inverse = false) {
  const n = re.length
  if (!isPow2(n)) throw new Error(`fft1d needs a power-of-two length, got ${n}`)
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const evenIndex = i + k
        const oddIndex = i + k + len / 2
        const oddRe = re[oddIndex] * curRe - im[oddIndex] * curIm
        const oddIm = re[oddIndex] * curIm + im[oddIndex] * curRe
        re[oddIndex] = re[evenIndex] - oddRe
        im[oddIndex] = im[evenIndex] - oddIm
        re[evenIndex] += oddRe
        im[evenIndex] += oddIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n }
  }
}

/** In-place 2D FFT (rows, then columns) over w×h planes. */
export function fft2d (re, im, width, height, inverse = false) {
  if (!isPow2(width) || !isPow2(height)) {
    throw new Error(`fft2d needs power-of-two dimensions, got ${width}×${height}`)
  }
  const rowRe = new Float32Array(width)
  const rowIm = new Float32Array(width)
  for (let y = 0; y < height; y++) {
    rowRe.set(re.subarray(y * width, (y + 1) * width))
    rowIm.set(im.subarray(y * width, (y + 1) * width))
    fft1d(rowRe, rowIm, inverse)
    re.set(rowRe, y * width)
    im.set(rowIm, y * width)
  }
  const colRe = new Float32Array(height)
  const colIm = new Float32Array(height)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) { colRe[y] = re[y * width + x]; colIm[y] = im[y * width + x] }
    fft1d(colRe, colIm, inverse)
    for (let y = 0; y < height; y++) { re[y * width + x] = colRe[y]; im[y * width + x] = colIm[y] }
  }
}
