/**
 * Generates the extension's PNG icons.
 *
 * Committed as a script rather than binary blobs so the icon can be adjusted
 * without a design tool, and so the repository carries no opaque assets. Chrome
 * requires PNG for `manifest.icons` (SVG is rejected), so the pixels are encoded
 * by hand here — the shape is simple enough that a rasteriser would be overkill.
 *
 * Run with: node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons')

/** CRC-32, required by every PNG chunk. */
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      // The reversed polynomial 0xEDB88320 is what the PNG spec mandates.
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBytes, data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** Encodes RGBA pixels as a PNG buffer. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // Each scanline is prefixed with its filter type; 0 (None) keeps this simple
  // and compresses well for flat colour.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Smooth coverage for one pixel, so edges are not jagged at 16px. */
function coverage(distance, edge, softness) {
  if (distance <= edge - softness) return 1
  if (distance >= edge + softness) return 0
  return (edge + softness - distance) / (2 * softness)
}

/**
 * Draws the icon: a rounded slate square with a cyan compass needle.
 *
 * A needle rather than a checkmark or a bug — the product's identity is
 * "领航"/piloting, and a green tick would be indistinguishable from every other
 * testing tool at 16 pixels.
 */
function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = size * 0.46
  const corner = size * 0.28
  const soft = Math.max(size * 0.02, 0.5)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center
      const dy = y - center

      // Rounded square via a superellipse: cheaper than corner arcs and it keeps
      // the silhouette recognisable when Chrome downscales to 16px.
      const squircle = Math.pow(Math.abs(dx) / radius, 4) + Math.pow(Math.abs(dy) / radius, 4)
      const inside = coverage(Math.pow(squircle, 0.25) * radius, radius, soft)
      if (inside <= 0) continue

      // Background: a vertical slate gradient, dark enough that the light needle
      // reads on both light and dark browser themes.
      const t = (y / size) * 0.35
      let r = Math.round(30 + t * 40)
      let g = Math.round(41 + t * 45)
      let b = Math.round(59 + t * 55)

      // The needle: a rotated arrow through the centre, drawn as two triangles
      // so the leading half can be brighter than the trailing half.
      const angle = -Math.PI / 4
      const along = dx * Math.cos(angle) + dy * Math.sin(angle)
      const across = -dx * Math.sin(angle) + dy * Math.cos(angle)
      const halfLength = size * 0.3
      const width = size * 0.115 * (1 - Math.abs(along) / halfLength)

      if (Math.abs(along) < halfLength && Math.abs(across) < Math.max(width, 0)) {
        if (along < 0) {
          // Leading half: cyan, the product's accent.
          r = 34
          g = 211
          b = 238
        } else {
          // Trailing half: muted, so the needle reads as directional.
          r = 148
          g = 163
          b = 184
        }
      }

      // A small hub keeps the two halves visually joined at small sizes.
      if (Math.hypot(dx, dy) < size * 0.055) {
        r = 241
        g = 245
        b = 249
      }

      const offset = (y * size + x) * 4
      rgba[offset] = r
      rgba[offset + 1] = g
      rgba[offset + 2] = b
      rgba[offset + 3] = Math.round(255 * inside)
    }
  }
  return encodePng(size, size, rgba)
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  const file = resolve(OUT_DIR, `icon-${size}.png`)
  writeFileSync(file, render(size))
  console.log(`wrote ${file}`)
}
