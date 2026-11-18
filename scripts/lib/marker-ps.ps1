# 用 PS 版（System.Drawing）算一批小图的行首淡黄占比，供 JS/kfocr 的 --marker 做对照。
# 输出：每行 `<路径>\t<百分比>`，与 `kfocr --marker 0.5 --list` 的输出可直接逐行比。
param(
    [Parameter(Mandatory)] [string] $PathsFile
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'events.ps1')

foreach ($p in (Get-Content -LiteralPath $PathsFile)) {
    if (-not $p) { continue }
    $score = Get-SelfMarkerScore -ImagePath $p -Fraction 0.5
    "$p`t$([math]::Round($score, 3))"
}
