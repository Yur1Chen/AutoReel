/**
 * 击杀条 ROI：按源视频分辨率换算（对应 highlight.ps1 里的同一段逻辑）。
 *
 * 基准标定在 2560x1440：宽 760 贴右边缘（击杀条右对齐，6 字对 6 字时条子会向左伸出，
 * 文档附录 A 的 560 会裁掉行首头像）。Valorant 的 HUD 随分辨率等比缩放，所以：
 *   scale = 源高度 / 1440；宽高与槽位纵坐标都乘 scale，横坐标用「右边缘对齐」算。
 *
 * 取整必须用 psRound（banker's），否则 1080p 的 172.5 会被算成 173 而不是 PS 版的 172。
 */
import { psRound } from './round.mjs'

const REF_H = 1440
const REF_SLOT_W = 760
const REF_SLOT_H = 50
const REF_SLOT_Y = [125, 178, 230]

/**
 * @param {number} width  源视频宽
 * @param {number} height 源视频高
 * @returns {{scale:number, x:number, w:number, h:number, slots:number[], profile:string}}
 */
export function roiFor (width, height) {
  const scale = height / REF_H
  const w = psRound(REF_SLOT_W * scale)
  const h = psRound(REF_SLOT_H * scale)
  const x = width - w
  const slots = REF_SLOT_Y.map(y => psRound(y * scale))
  const profile = Math.abs(scale - 1.0) < 0.001 ? 'ref-1440p' : `scaled-${width}x${height}`
  return { scale, x, w, h, slots, profile }
}
