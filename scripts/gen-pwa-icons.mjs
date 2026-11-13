/**
 * gen-pwa-icons.mjs — 从 DSH 桌面端应用图标生成 PWA 全尺寸图标。
 *
 * 背景（2026-11-12 用户反馈）：PWA 桌面图标必须与 DSH 桌面程序图标一致，
 * 早期误做成插件自己的蓝色渐变「大地球」瓦片。现在一律以 DSH 安装目录
 * resources/icon.png（1024x1024，白底圆角瓦片 + 深色官方图形）为唯一母版，
 * vendored 副本在 assets/branding/dsh-app-icon.png，避免依赖安装路径。
 *
 * 产出（写入 assets/pwa-icons/）：
 *   icon-192.png / icon-512.png     —— 透明圆角（purpose: any，浏览器自行加圆角）
 *   apple-touch-icon.png (180)      —— iOS 会自己套圆角遮罩，必须铺白底不透明
 *   icon-maskable-512.png (512)     —— maskable 会被裁成圆形，图形缩到安全区 ~76%
 *
 * 用法：node scripts/gen-pwa-icons.mjs
 */
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const MASTER = join(ROOT, 'assets', 'branding', 'dsh-app-icon.png')
const OUT = join(ROOT, 'assets', 'pwa-icons')

// jimp 是可选用到的图像工具库：优先本项目 node_modules，其次全局安装。
// 本脚本产出的 assets/pwa-icons/ 已随仓库提交，日常构建/发布不需要它。
const require2 = createRequire(import.meta.url)
const JIMP_CANDIDATES = [
  'jimp',
  join(ROOT, 'node_modules', 'jimp'),
]
let Jimp = null
for (const id of JIMP_CANDIDATES) {
  try {
    Jimp = require2(id).Jimp
    if (Jimp) break
  } catch {
    /* 试下一个 */
  }
}
if (!Jimp) {
  console.error('❌ 找不到 jimp（需要重新生成 PWA 图标时请 npm i -D jimp）')
  process.exit(1)
}

/** maskable 安全区：图形占画布 88%，四周留白避免圆形裁切切到鲸鱼头部/尾部尖端 */
const MASKABLE_INSET = 0.88

const master = await Jimp.read(MASTER)
console.log(`母版 ${MASTER}  ${master.bitmap.width}x${master.bitmap.height}`)

/** 直接缩放（保留母版的透明圆角） */
async function emitPlain(name, size) {
  const img = master.clone().resize({ w: size, h: size })
  await img.write(join(OUT, name))
  return size
}

/** 铺白底后缩放（iOS/maskable 不允许透明） */
async function emitFlattened(name, size) {
  const glyph = master.clone().resize({ w: size, h: size })
  const canvas = new Jimp({ width: size, height: size, color: 0xffffffff })
  canvas.composite(glyph, 0, 0)
  await canvas.write(join(OUT, name))
  return size
}

/** 铺白底 + 图形缩小居中（maskable 安全区） */
async function emitMaskable(name, size) {
  const inner = Math.round(size * MASKABLE_INSET)
  const glyph = master.clone().resize({ w: inner, h: inner })
  const canvas = new Jimp({ width: size, height: size, color: 0xffffffff })
  const off = Math.round((size - inner) / 2)
  canvas.composite(glyph, off, off)
  await canvas.write(join(OUT, name))
  return size
}

await emitPlain('icon-192.png', 192)
await emitPlain('icon-512.png', 512)
await emitFlattened('apple-touch-icon.png', 180)
await emitMaskable('icon-maskable-512.png', 512)

console.log('\n✅ PWA 图标生成完成（母版 = DSH 桌面应用图标）')
for (const f of readdirSync(OUT).sort()) console.log('   ' + f)
