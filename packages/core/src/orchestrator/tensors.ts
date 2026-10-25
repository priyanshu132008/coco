import { inflateSync } from 'node:zlib'

// ponytail: hand-rolled PNG decode (8-bit RGB/RGBA, filters 0-4, no interlace — playwright output only)
// and hash-based 768-d text embeddings. Swap for the real embedder + ImageNet normalization
// when the trainer publishes the preprocessing spec.

/** Model input geometry (matches coco_full_v1.onnx metadata). */
export const IMG_SIZE = 224
export const DOM_TOKENS = 32
export const DOM_EMBED_DIM = 768

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Decodes an 8-bit RGB/RGBA PNG into raw bytes (channels interleaved, unfiltered). */
export function decodePng(buf: Buffer): { width: number; height: number; channels: number; data: Buffer } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    if (type === 'IHDR') {
      width = buf.readUInt32BE(pos + 8)
      height = buf.readUInt32BE(pos + 12)
      bitDepth = buf[pos + 16]
      colorType = buf[pos + 17]
      if (buf[pos + 20] === 1) throw new Error('interlaced PNG unsupported')
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(pos + 8, pos + 8 + len))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG variant: bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const data = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = data.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = row[x]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) v = (v + paeth(a, b, c)) & 255
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`)
      out[x] = v
    }
    prev = out
  }
  return { width, height, channels, data }
}

/** ImageNet channel stats — the trainer's assumed screenshot normalizer. */
const IMG_MEAN = [0.485, 0.456, 0.406]
const IMG_STD = [0.229, 0.224, 0.225]

/** PNG buffer → float32 CHW [3,224,224], nearest-neighbor resize, /255, ImageNet mean/std. */
export function screenshotTensor(png: Buffer): Float32Array {
  const { width, height, channels, data } = decodePng(png)
  const t = new Float32Array(3 * IMG_SIZE * IMG_SIZE)
  for (let y = 0; y < IMG_SIZE; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / IMG_SIZE))
    for (let x = 0; x < IMG_SIZE; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / IMG_SIZE))
      const i = (sy * width + sx) * channels
      for (let ch = 0; ch < 3; ch++) {
        t[ch * IMG_SIZE * IMG_SIZE + y * IMG_SIZE + x] = (data[i + ch] / 255 - IMG_MEAN[ch]) / IMG_STD[ch]
      }
    }
  }
  return t
}

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Deterministic bag-of-tokens bucket embedding (djb2 → 768 buckets, length-scaled). */
export function domEmbedding(text: string): Float32Array {
  const v = new Float32Array(DOM_EMBED_DIM)
  const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const tok of toks) v[djb2(tok) % DOM_EMBED_DIM] += 1 / Math.sqrt(tok.length)
  return v
}

/** dom_snippet JSON (desktop or mobile schema) → float32 [32,768]; padding rows stay zero. */
export function domTensor(domTreeJson: string): Float32Array {
  let nodes: Record<string, unknown>[] = []
  try {
    nodes = JSON.parse(domTreeJson)
  } catch {
    // leave zero-padded tensor
  }
  const t = new Float32Array(DOM_TOKENS * DOM_EMBED_DIM)
  nodes.slice(0, DOM_TOKENS).forEach((n, i) => {
    const text = [
      n.tag ?? n.class,
      n.id ?? n['resource-id'],
      n.text,
      n.placeholder,
      n.ariaLabel ?? n['content-desc'],
    ]
      .filter(Boolean)
      .join(' ')
    t.set(domEmbedding(text), i * DOM_EMBED_DIM)
  })
  return t
}