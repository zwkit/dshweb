/**
 * gen-pwa-icons.mjs — 生成 dshweb 的 PWA 图标（纯 Node，零第三方依赖）。
 *
 * 品牌口径（2026-11-14 用户确认）：「PWA 程序图标不要带边框，中间鲸鱼就行」。
 * 即图标只保留 DSH 官方鲸鱼本体，去掉白色圆角瓦片、浅色描边环与阴影；
 * 透明底 PNG 用于 purpose:any，白底 PNG 用于 iOS / maskable，favicon.ico
 * 同样只画鲸鱼、透明底。
 *
 * 矢量来源：assets/pwa-icons/favicon.svg 内 <path id="path"> 的 d（官方鲸鱼，
 * viewBox 0 0 50 50，fill-rule="nonzero"）。该 path 由 1 个主体子路径 + 3 个
 * 反向绕向的内部子路径组成；nonzero 下内部挖空，等价于 even-odd 填充。
 * 生成器直接解析该 d，用 cubic bezier 展平 + 扫描线填充 + 4× 超采样得到
 * alpha 蒙版，再手写最小 PNG（RGBA / filter 0 / zlib）与 PNG-in-ICO。
 *
 * 产出（写入 assets/pwa-icons/）：
 *   icon-192.png / icon-512.png   —— 透明底鲸鱼（purpose: any）
 *   apple-touch-icon.png (180)    —— 纯白底鲸鱼（iOS 自己套圆角遮罩）
 *   icon-maskable-512.png (512)   —— 纯白底鲸鱼，缩到安全区避免圆形裁切
 *   favicon.ico (16/32/48/64)     —— 透明底鲸鱼，PNG-in-ICO
 *
 * 用法：node scripts/gen-pwa-icons.mjs
 * 之后跑 node scripts/build.cjs 同步 lib/pwa-icons 与 lib/pwa-manifest.json。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SVG = join(ROOT, 'assets', 'pwa-icons', 'favicon.svg')
const OUT = join(ROOT, 'assets', 'pwa-icons')

// 官方鲸鱼深色（与历史母版 assets/branding/dsh-app-icon.png 的主色一致）
const WHALE = [45, 49, 57]   // #2D3139 —— 与官方母版 assets/branding/dsh-app-icon.png 的鲸鱼主色一致
const WHITE = [0xff, 0xff, 0xff]
const SS = 4                         // 每像素 4×4 超采样

/** maskable 安全区：鲸鱼占画布 80%，四周留白避免圆形裁切切到头/尾尖端 */
const MASKABLE_INSET = 0.8

// ── 1. 解析官方鲸鱼 SVG 的 <path d="..."> ──────────────────────────────
function parsePath(svg) {
  const d = (svg.match(/<path\b[^>]*\bd="([^"]+)"/) || [])[1]
  if (!d) throw new Error('favicon.svg 里找不到 <path d="...">')
  const toks = d.match(/[MmCcLlHhVvZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || []
  let i = 0, cur = [0, 0], start = null, sub = null
  const subs = []
  const num = () => parseFloat(toks[i++])
  while (i < toks.length) {
    const c = toks[i++]
    if (c === 'Z' || c === 'z') {
      if (sub && sub.length >= 3) { sub.push([...start]); subs.push(sub) }
      sub = null; cur = [...start]
    } else if (c === 'M' || c === 'm') {
      let x = num(), y = num()
      if (c === 'm') { x += cur[0]; y += cur[1] }
      cur = [x, y]; start = [x, y]
      if (sub && sub.length >= 3) { sub.push([...start]); subs.push(sub) }
      sub = [[x, y]]
    } else if (c === 'C' || c === 'c') {
      let a = num(), b = num(), cc = num(), dd = num(), x = num(), y = num()
      if (c === 'c') { a += cur[0]; b += cur[1]; cc += cur[0]; dd += cur[1]; x += cur[0]; y += cur[1] }
      if (!sub) sub = [[...cur]]
      // 自适应展平：控制多边形长度越长取越多段，保证 512px 下曲线平滑
      const len = Math.hypot(a - cur[0], b - cur[1]) + Math.hypot(cc - a, dd - b) + Math.hypot(x - cc, y - dd)
      const n = Math.max(8, Math.min(64, Math.ceil(len * 3)))
      const p0 = cur, p1 = [a, b], p2 = [cc, dd], p3 = [x, y]
      for (let s = 1; s <= n; s++) {
        const t = s / n, u = 1 - t
        sub.push([
          u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
          u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1],
        ])
      }
      cur = [x, y]
    } else if (c === 'L' || c === 'l') {
      let x = num(), y = num()
      if (c === 'l') { x += cur[0]; y += cur[1] }
      if (!sub) sub = [[...cur]]
      sub.push([x, y]); cur = [x, y]
    } else {
      throw new Error('SVG path 含未支持的命令: ' + c)
    }
  }
  if (sub && sub.length >= 3) { sub.push([...start]); subs.push(sub) }
  return subs
}

const subs = parsePath(readFileSync(SVG, 'utf8'))
const bb = subs.flat().reduce((a, p) => [Math.min(a[0],p[0]), Math.min(a[1],p[1]), Math.max(a[2],p[0]), Math.max(a[3],p[1])], [1e9,1e9,-1e9,-1e9])
console.log('官方鲸鱼 path：' + subs.length + ' 个子路径，bbox ' + bb.map(n=>n.toFixed(2)).join(','))

// ── 2. 扫描线 even-odd 填充（在 viewBox 50×50 坐标系里） ───────────────
// 把所有子路径展平成一条边表，随后按「超采样行」求交点并填 span，
// 复杂度 O(超采样行数 × 边数)，而不是 O(像素 × 边数)。
const EDGES = []
for (const sp of subs) {
  for (let j = 0; j < sp.length - 1; j++) {
    const [x1,y1] = sp[j], [x2,y2] = sp[j+1]
    if (y1 !== y2) EDGES.push([x1, y1, x2, y2])
  }
}

/**
 * 渲染一张 size×size 的 RGBA 像素缓冲：先在 size*SS 的超采样网格上做
 * 二值扫描线填充，再把每个 SS×SS 小块平均成覆盖率 → 边缘抗锯齿。
 * scale / offX / offY 把 50×50 的鲸鱼等比居中映射到画布。
 * 背景 bg=null 表示透明，否则为 [r,g,b] 纯色底（鲸鱼按覆盖率合成上去）。
 */
function render(size, { scale, offX, offY, bg = null, color = WHALE }) {
  const N = size * SS, sS = scale * SS, oX = offX * SS, oY = offY * SS
  const cov = new Uint16Array(size * size)
  const xs = []
  for (let hy = 0; hy < N; hy++) {
    const uy = (hy + 0.5 - oY) / sS
    xs.length = 0
    for (let e = 0; e < EDGES.length; e++) {
      const [x1,y1,x2,y2] = EDGES[e]
      if ((y1 > uy) !== (y2 > uy)) {
        xs.push(x1 + (uy - y1) * (x2 - x1) / (y2 - y1))
      }
    }
    if (xs.length < 2) continue
    xs.sort((a, b) => a - b)
    const py = (hy / SS) | 0
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let g0 = Math.ceil(xs[k] * sS + oX - 0.5)
      let g1 = Math.ceil(xs[k+1] * sS + oX - 0.5)
      if (g0 < 0) g0 = 0
      if (g1 > N) g1 = N
      for (let gx = g0; gx < g1; gx++) cov[py * size + ((gx / SS) | 0)]++
    }
  }
  const px = Buffer.alloc(size * size * 4)
  const total = SS * SS
  for (let p = 0; p < size * size; p++) {
    const a = Math.round(255 * cov[p] / total)
    const o = p * 4
    if (bg) {
      px[o]   = Math.round(bg[0] + (color[0] - bg[0]) * a / 255)
      px[o+1] = Math.round(bg[1] + (color[1] - bg[1]) * a / 255)
      px[o+2] = Math.round(bg[2] + (color[2] - bg[2]) * a / 255)
      px[o+3] = 255
    } else {
      px[o] = color[0]; px[o+1] = color[1]; px[o+2] = color[2]; px[o+3] = a
    }
  }
  return px
}

/** 把 bbox=(bb) 的鲸鱼按给定占比居中铺进 size 画布，返回 {scale,offX,offY}。 */
function fit(size, inset) {
  const w = bb[2] - bb[0], h = bb[3] - bb[1]
  const scale = Math.min(size * inset / w, size * inset / h)
  return {
    scale,
    offX: (size - w * scale) / 2 - bb[0] * scale,
    offY: (size - h * scale) / 2 - bb[1] * scale,
  }
}

// ── 3. 手写最小 PNG 编码器（RGBA / 8bit / filter 0）+ ICO 容器 ──────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : (c >>> 1)
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const cc = Buffer.alloc(4); cc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, cc])
}
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8bit RGBA
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0 // filter type 0
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
function encodeIco(sizes) {
  const images = sizes.map(s => ({ s, png: encodePng(s, render(s, fit(s, 0.92))) }))
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach((im, i) => {
    const o = i * 16
    dir[o] = im.s >= 256 ? 0 : im.s
    dir[o+1] = im.s >= 256 ? 0 : im.s
    dir[o+2] = 0; dir[o+3] = 0
    dir.writeUInt16LE(1, o+4); dir.writeUInt16LE(32, o+6)
    dir.writeUInt32LE(im.png.length, o+8)
    dir.writeUInt32LE(offset, o+12)
    offset += im.png.length
  })
  return Buffer.concat([head, dir, ...images.map(im => im.png)])
}

// ── 4. 出图 ────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true })
function emit(name, buf) {
  writeFileSync(join(OUT, name), buf)
  console.log('  ' + name.padEnd(26) + ' ' + buf.length + ' B')
}
console.log('生成 PWA 图标（纯鲸鱼 / 无瓦片 / 无边框）：')
for (const size of [192, 512]) {
  emit('icon-' + size + '.png', encodePng(size, render(size, fit(size, 0.92))))
}
emit('apple-touch-icon.png', encodePng(180, render(180, { ...fit(180, 0.84), bg: WHITE })))
emit('icon-maskable-512.png', encodePng(512, render(512, { ...fit(512, MASKABLE_INSET), bg: WHITE })))
emit('favicon.ico', encodeIco([16, 32, 48, 64]))
console.log('\n✅ 完成。下一步：node scripts/build.cjs 同步 lib/')
