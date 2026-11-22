// Minimal zero-dependency QR Code SVG generator (Versions 1-10, Byte mode, ECC Level L)
// Designed for offline QR pairing between Laptop (Display) and iPad (Controller)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

// [totalCodewords, ecPerBlock, blocksG1, dataG1, blocksG2, dataG2, alignPositions]
// ECC Level L (7% recovery, smallest & cleanest QR for URLs)
const VERSIONS = [
  null,
  [26, 7, 1, 19, 0, 0, []],
  [44, 10, 1, 34, 0, 0, [6, 18]],
  [70, 15, 1, 55, 0, 0, [6, 22]],
  [100, 20, 1, 80, 0, 0, [6, 26]],
  [134, 26, 1, 108, 0, 0, [6, 30]],
  [172, 18, 2, 68, 0, 0, [6, 34]],
  [196, 20, 2, 78, 0, 0, [6, 22, 38]],
  [242, 24, 2, 97, 0, 0, [6, 24, 42]],
  [292, 30, 2, 116, 0, 0, [6, 26, 46]],
  [346, 18, 2, 68, 2, 69, [6, 28, 50]]
];

function bchFormat(ecBits, mask) {
  const data = (ecBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function bchVersion(ver) {
  let rem = ver << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (ver << 12) | rem;
}

function maskFn(m, r, c) {
  switch (m) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

export function encodeQR(text) {
  const bytes = new TextEncoder().encode(String(text));
  let ver = 0;
  for (let v = 1; v < VERSIONS.length; v++) {
    const info = VERSIONS[v];
    const dataCap = info[2] * info[3] + info[4] * info[5];
    const headerBytes = v < 10 ? 2 : 3;
    if (bytes.length + headerBytes <= dataCap) {
      ver = v;
      break;
    }
  }
  if (!ver) throw new Error('Text too long for QR code');

  const [, ecLen, b1, d1, b2, d2, align] = VERSIONS[ver];
  const dataCap = b1 * d1 + b2 * d2;

  // Build bit stream: Byte mode (0100), length (8 or 16 bits), payload, terminator
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  const maxBits = dataCap * 8;
  pushBits(0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(dataCap);
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data[i >> 3] = v;
  }
  let padIdx = bits.length >> 3;
  const padBytes = [0xec, 0x11];
  for (let i = 0; padIdx < dataCap; i++, padIdx++) {
    data[padIdx] = padBytes[i & 1];
  }

  // Split into blocks & compute ECC
  const blocks = [];
  const ecs = [];
  let offset = 0;
  for (let i = 0; i < b1; i++) {
    const blk = data.slice(offset, offset + d1);
    offset += d1;
    blocks.push(blk);
    ecs.push(rsRemainder(blk, ecLen));
  }
  for (let i = 0; i < b2; i++) {
    const blk = data.slice(offset, offset + d2);
    offset += d2;
    blocks.push(blk);
    ecs.push(rsRemainder(blk, ecLen));
  }

  // Interleave codewords
  const codewords = [];
  const maxD = Math.max(d1, d2);
  for (let i = 0; i < maxD; i++) {
    for (const blk of blocks) {
      if (i < blk.length) codewords.push(blk[i]);
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const ec of ecs) codewords.push(ec[i]);
  }

  // Matrix setup
  const size = ver * 4 + 17;
  const mat = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunc = (r, c, val) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      mat[r][c] = val ? 1 : 0;
      isFunc[r][c] = 1;
    }
  };

  // Finder patterns + separators
  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        setFunc(r, c, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      const r0 = align[i], c0 = align[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFunc(r0 + dr, c0 + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (!isFunc[6][i]) setFunc(6, i, (i & 1) === 0);
    if (!isFunc[i][6]) setFunc(i, 6, (i & 1) === 0);
  }

  // Dark module & reserve format areas
  setFunc(size - 8, 8, 1);
  for (let i = 0; i < 9; i++) {
    if (!isFunc[8][i]) setFunc(8, i, 0);
    if (!isFunc[i][8]) setFunc(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    setFunc(8, size - 1 - i, 0);
    setFunc(size - 1 - i, 8, 0);
  }

  // Version info (v >= 7)
  if (ver >= 7) {
    const vbits = bchVersion(ver);
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >> i) & 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  // Place data bits in zigzag
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = (((right + 1) & 2) === 0);
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (isFunc[r][c]) continue;
        let dark = 0;
        if (bitIdx < totalBits) {
          dark = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        mat[r][c] = dark;
      }
    }
  }

  // Choose best mask (0..7)
  const applyFormat = (grid, mask) => {
    // EC Level L = 01
    const fmt = bchFormat(0b01, mask);
    for (let i = 0; i <= 5; i++) grid[8][i] = (fmt >> i) & 1;
    grid[8][7] = (fmt >> 6) & 1;
    grid[8][8] = (fmt >> 7) & 1;
    grid[7][8] = (fmt >> 8) & 1;
    for (let i = 9; i < 15; i++) grid[14 - i][8] = (fmt >> i) & 1;
    for (let i = 0; i < 8; i++) grid[size - 1 - i][8] = (fmt >> i) & 1;
    for (let i = 8; i < 15; i++) grid[8][size - 15 + i] = (fmt >> i) & 1;
    grid[size - 8][8] = 1;
  };

  const penalty = grid => {
    let score = 0;
    // Adjacent modules in row/col
    for (let r = 0; r < size; r++) {
      let runR = 1, runC = 1;
      for (let c = 1; c < size; c++) {
        if (grid[r][c] === grid[r][c - 1]) {
          runR++;
          if (runR === 5) score += 3;
          else if (runR > 5) score += 1;
        } else runR = 1;
        if (grid[c][r] === grid[c - 1][r]) {
          runC++;
          if (runC === 5) score += 3;
          else if (runC > 5) score += 1;
        } else runC = 1;
      }
    }
    // 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = grid[r][c];
        if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
      }
    }
    // Balance
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += grid[r][c];
    const ratio = Math.abs(dark * 100 / (size * size) - 50);
    score += Math.floor(ratio / 5) * 10;
    return score;
  };

  let bestGrid = null;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const g = mat.map((row, r) => row.map((v, c) => (isFunc[r][c] ? v : v ^ (maskFn(m, r, c) ? 1 : 0))));
    applyFormat(g, m);
    const sc = penalty(g);
    if (sc < bestScore) {
      bestScore = sc;
      bestGrid = g;
    }
  }

  return { size, grid: bestGrid };
}

export function qrToSvg(text, px = 200) {
  const { size, grid } = encodeQR(text);
  const quiet = 4;
  const full = size + quiet * 2;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) {
        path += `M${c + quiet},${r + quiet}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR Code"><rect width="${full}" height="${full}" fill="#ffffff" rx="2"/><path d="${path}" fill="#000000"/></svg>`;
}
