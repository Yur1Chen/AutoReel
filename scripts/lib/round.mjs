/**
 * PowerShell `[math]::Round` 的等价实现：.5 进偶数（banker's rounding），
 * 不是 JS 的 Math.round（.5 一律进位）。§11.3 点名的坑。
 *
 * 真要命的是 ROI 换算：1080p 下 `230 * 0.75 = 172.5`，PS 得 172、JS 的 Math.round 得 173，
 * 槽位差 1px 会让两个引擎的 OCR 输入不同，金样比对直接报出来。
 *
 * @param {number} value
 * @param {number} [digits]
 */
export function psRound (value, digits = 0) {
  if (!Number.isFinite(value)) return value
  const f = 10 ** digits
  const x = value * f
  const floor = Math.floor(x)
  const diff = x - floor
  let n
  if (diff > 0.5) n = floor + 1
  else if (diff < 0.5) n = floor
  else n = floor % 2 === 0 ? floor : floor + 1
  return n / f
}
