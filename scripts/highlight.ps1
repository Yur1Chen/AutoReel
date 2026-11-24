#Requires -Version 7.0
<#
.SYNOPSIS
  从 NVIDIA 即时回放里按“击杀信息栏 OCR”剪出集锦。

.DESCRIPTION
  一步从 NVIDIA 即时回放剪出击杀集锦：抽帧 → OCR → 重建击杀事件 → 切片 → 拼接。

  输出只保留成片：默认写到 out/<素材名>/highlight_reel.mp4，目录里不会有别的文件。
  中间产物（抽帧、OCR 结果、切片）默认放在系统临时目录，跑完自动删除；
  需要复用或排查时加 -KeepWork，并把 -Work 指到一个想保留的目录。

  抽帧默认走文档 §8.2 的“单次解码 + split=N”，比逐槽各解码一遍快约 3 倍；
  -LegacyExtract 可切回旧行为用于对比。

.PARAMETER Source
  源录像，2560x1440 / 60fps 的 NVIDIA 即时回放 .DVR.mp4。
.PARAMETER LocalId
  本地玩家 ID。默认 'auto'：从「行首带黄色头像框」的那些行推断（见 scripts/lib/events.ps1）。
  推断样本不足时会直接报错，此时用 -LocalId <你的ID> 显式指定。
.PARAMETER ScanFps
  扫描帧率，默认 2（击杀条停留 4-5s，2fps 时间精度 ±0.5s）。
.PARAMETER OcrExe
  kfocr 可执行文件路径，默认 <repo>/kfocr/target/{debug|release}/kfocr.exe。
.PARAMETER Models
  OCR 模型目录（需含 det.rten / rec.rten / ppocrv6_dict.txt）。
  默认取环境变量 TACK_OCR_MODELS；两者都没有就报错，不再回落到作者机器的路径。
.PARAMETER Out
  成片目录，默认 <repo>/out/<素材名>（去掉 "Valorant " 前缀与 ".DVR" 后缀）。
.PARAMETER Work
  中间产物目录，默认系统临时目录下的 AutoReel/<素材名>。
.PARAMETER KeepWork
  保留中间产物（配合 -Reuse 复跑时用），默认跑完删除。
.PARAMETER Release
  使用 release 构建的 kfocr（opt3 + lto + cgu=1），比 debug 快 3-4 倍。
.PARAMETER Machine
  机器可读模式：stdout 只输出 `HC <json>` 事件行（供 DSH 插件解析），
  人读信息全部改走 stderr。事件类型见 docs/PLUGIN-PLAN.md §M0：
  stage / progress / localId / kills / segments / result。
  注意不能叫 -Events：PowerShell 变量名不区分大小写，会和脚本里的 $events（击杀事件）撞车。
.PARAMETER Roi
  击杀条 ROI override，格式 "x,w,h,y1,y2,y3"（源视频像素）。默认 auto：按 ffprobe 读到的
  高度相对 1440p 等比缩放，横向贴右边缘 —— 1080p / 2K / 4K / 21:9 都不用手配。
  HUD 缩放调过的机子识别不出来时再显式给。
.PARAMETER Pre
  击杀前留几秒，默认 3.5（0-10）。
.PARAMETER Post
  击杀后留几秒，默认 1.5（0-10）。
#>
param(
    [Parameter(Mandatory)] [string] $Source,
    [string] $LocalId = 'auto',
    [int]    $ScanFps = 2,
    [string] $OcrExe,
    [string] $Models = $env:TACK_OCR_MODELS,
    [string] $Work,
    [string] $Out,
    [switch] $Reuse,
    [switch] $LegacyExtract,
    [switch] $Release,
    [switch] $SingleOcr,
    [int]    $ChunkSize = 60,
    [switch] $KeepWork,
    [switch] $Machine,
    [string] $Roi = 'auto',
    [double] $Pre = 3.5,
    [double] $Post = 1.5
)

$ErrorActionPreference = 'Stop'
$swTotal = [Diagnostics.Stopwatch]::StartNew()

# ── 输出：人读信息 vs 机器事件 ──────────────────────────────────
# -Events 时 stdout 必须干净（只有 HC 行），否则插件解析会被 Write-Host 污染。
# 实测：pwsh 的 Write-Host 在 stdout 被重定向时仍会落到 stdout，所以这里显式分流。
function Write-Note {
    param([string] $Text = '')
    if ($Machine) { [Console]::Error.WriteLine($Text) } else { Write-Host $Text }
}

# 注意：参数名不能叫 $Ev —— 它和 common parameter 的 -ErrorVariable 别名冲突，
# PowerShell 会直接拒绝绑定（`无法指定参数"Ev"`）。
function Write-Event {
    param([Parameter(Mandatory)] [string] $Name, [hashtable] $Data = @{})
    if (-not $Machine) { return }
    $o = [ordered]@{ ev = $Name }
    foreach ($k in $Data.Keys) { $o[$k] = $Data[$k] }
    [Console]::Out.WriteLine('HC ' + ($o | ConvertTo-Json -Compress -Depth 6))
}

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\events.ps1')
if (-not $OcrExe) {
    $OcrExe = if ($Release) { Join-Path $root 'kfocr\target\release\kfocr.exe' }
              else          { Join-Path $root 'kfocr\target\debug\kfocr.exe' }
}
if (-not (Test-Path -LiteralPath $Source)) { throw "源录像不存在: $Source" }
if (-not (Test-Path -LiteralPath $OcrExe)) { throw "OCR 可执行文件不存在: $OcrExe  （先 cargo build --offline）" }
# 模型目录：-Models > TACK_OCR_MODELS；都没有就报错（不再回落到作者机器的路径）
if (-not $Models) {
    throw "-Models 未指定，也没有 TACK_OCR_MODELS 环境变量（目录里需 det.rten / rec.rten / ppocrv6_dict.txt，见 THIRD_PARTY.md）"
}
if (-not (Test-Path -LiteralPath $Models)) { throw "OCR 模型目录不存在: $Models" }
$Models = (Resolve-Path -LiteralPath $Models).Path

# 素材名：去掉 "Valorant " 前缀和 ".DVR" 后缀，作为输出目录名
$stem = ([IO.Path]::GetFileNameWithoutExtension($Source) -replace '^Valorant\s+', '') -replace '\.DVR$', ''
if (-not $Out)  { $Out  = Join-Path $root "out\$stem" }
# 中间产物默认进系统临时目录：用户只需要成片，这些文件不该出现在 out/ 里
if (-not $Work) { $Work = Join-Path ([IO.Path]::GetTempPath()) "AutoReel\$stem" }

$ff = (Get-Command ffmpeg -ErrorAction Stop).Source

# ── 击杀条 ROI：按源视频规格自适应 ──────────────────────────────
# 基准标定在 2560x1440（文档附录 A 给的是 x 1990 宽 560，但击杀条右对齐：杀手名 + 受害者名
# 都是 6 个汉字时条子会向左伸出、行首头像被裁掉，实测 `比奇堡恶霸鱼原神转瓦偏运动` 那行，
# 所以放宽到宽 760 并贴右边）。
#
# Valorant 的 HUD 随分辨率等比缩放，而击杀条始终贴右上角，所以换算规则是：
#   scale = 源高度 / 1440；宽高与槽位纵坐标都乘 scale，横坐标用「右边缘对齐」算。
# 这样 1080p / 2K / 4K / 21:9 都不用另配表。HUD 缩放比例调过的机子识别不出来时，
# 再用 -Roi "x,w,h,y1,y2,y3" 显式覆盖。
$REF_H = 1440
$REF_SLOT_W = 760; $REF_SLOT_H = 50
$REF_SLOT_Y = @(125, 178, 230)

$mediaProbe = & ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate -of default=nw=1 $Source 2>$null
$srcW = 0; $srcH = 0; $srcFps = 60
foreach ($l in $mediaProbe) {
    if ($l -match '^width=(\d+)') { $srcW = [int]$Matches[1] }
    elseif ($l -match '^height=(\d+)') { $srcH = [int]$Matches[1] }
    elseif ($l -match '^avg_frame_rate=(\d+)/(\d+)' -and [int]$Matches[2] -gt 0) { $srcFps = [int]([double]$Matches[1] / [double]$Matches[2]) }
}
if ($srcW -le 0 -or $srcH -le 0) { throw "无法读取视频分辨率（ffprobe 失败）: $Source" }

$scale = [double]$srcH / $REF_H
$slotW = [int][math]::Round($REF_SLOT_W * $scale)
$slotH = [int][math]::Round($REF_SLOT_H * $scale)
$slotX = [int]($srcW - $slotW)
$slots = @($REF_SLOT_Y | ForEach-Object { [int][math]::Round($_ * $scale) })
$roiProfile = if ([math]::Abs($scale - 1.0) -lt 0.001) { 'ref-1440p' } else { ('scaled-{0}x{1}' -f $srcW, $srcH) }

# 显式覆盖：-Roi "x,w,h,y1,y2,y3"
if ($Roi -and $Roi -ne 'auto') {
    $p = @($Roi -split ',' | ForEach-Object { [int]$_.Trim() })
    if ($p.Count -lt 6) { throw "-Roi 需要 6 个整数: x,w,h,y1,y2,y3（收到: $Roi）" }
    $slotX = $p[0]; $slotW = $p[1]; $slotH = $p[2]; $slots = @($p[3], $p[4], $p[5])
    $roiProfile = 'explicit'
}

Write-Event 'media' @{
    width = $srcW; height = $srcH; fps = $srcFps
    scale = [math]::Round($scale, 4); profile = $roiProfile
    roi = @{ x = $slotX; w = $slotW; h = $slotH; slots = $slots }
}

# ── 剪辑参数 ───────────────────────────────────────────────────
# 前摇 3.5s / 后摇 1.5s 沿用旧 demo.ps1。
# 合并阈值取「前摇 + 后摇」= 5.0s：两次击杀间隔小于这个值时，后者的前摇会压到前者的后摇上，
# 切成两段就会有一截画面重复（同一行击杀条横跨两个切片）。间隔小于 5s 说明同一次交战
# （killfeed 一行本来就要停留 4-5s），直接并成一段。
if ($Pre -lt 0 -or $Post -lt 0 -or $Pre -gt 10 -or $Post -gt 10) {
    throw "-Pre / -Post 需要 0-10 的秒数（收到 Pre=$Pre Post=$Post）"
}
$PRE = $Pre; $POST = $Post; $MERGE = $PRE + $POST; $MAXSEG = 12.0

Write-Event 'stage' @{ name = 'extract'; pct = 0; text = "抽帧 fps=$ScanFps" }

if ($Reuse -and (Test-Path -LiteralPath (Join-Path $Work 'slots'))) {
    Write-Note "[0/4] -Reuse：沿用 $Work 下已有的抽帧与 OCR 结果"
} else {
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
# clips 每次都要重建：-Reuse 只复用抽帧与 OCR，切片必须重新生成，否则上一轮的旧片段会残留
Remove-Item -LiteralPath (Join-Path $Work 'clips') -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $Work 'slots'), (Join-Path $Work 'clips') | Out-Null

Write-Note "[1/4] 抽帧 fps=$ScanFps（单次解码 + split=$($slots.Count)，文档 §8.2）..."
if ((Test-Path -LiteralPath (Join-Path $Work 'slots\0\0001.png')) -and $Reuse) {
    Write-Note "   复用已有抽帧"
    Write-Event 'progress' @{ pct = 10; text = '复用已有抽帧' }
} else {
    for ($s = 0; $s -lt $slots.Count; $s++) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Work "slots\$s") | Out-Null
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    if ($LegacyExtract) {
        # 旧实现：每个槽位各跑一次 ffmpeg，每次都完整解码整片
        for ($s = 0; $s -lt $slots.Count; $s++) {
            & $ff -y -v error -i $Source -vf "fps=$ScanFps,crop=${slotW}:${slotH}:${slotX}:$($slots[$s])" (Join-Path $Work "slots\$s\%04d.png")
            if ($LASTEXITCODE -ne 0) { throw "抽帧失败: slot=$s" }
        }
    } else {
        # 单次解码 + split=N，每条分支只裁自己那条 ROI
        $branches = 0..($slots.Count - 1) | ForEach-Object { "[b$_]" }
        $graph = [System.Collections.Generic.List[string]]::new()
        $graph.Add("fps=$ScanFps,split=$($slots.Count)" + ($branches -join ''))
        for ($s = 0; $s -lt $slots.Count; $s++) {
            $graph.Add("$($branches[$s])crop=${slotW}:${slotH}:${slotX}:$($slots[$s])[s$s]")
        }
        $fgFile = Join-Path $Work 'fg.txt'
        Set-Content -LiteralPath $fgFile -Value ($graph -join ';') -Encoding ascii

        $mapArgs = [System.Collections.Generic.List[string]]::new()
        for ($s = 0; $s -lt $slots.Count; $s++) {
            $mapArgs.Add('-map'); $mapArgs.Add("[s$s]")
            $mapArgs.Add((Join-Path $Work "slots\$s\%04d.png"))
        }
        & $ff -y -v error -i $Source -/filter_complex $fgFile @mapArgs
        if ($LASTEXITCODE -ne 0) { throw '抽帧失败（-/filter_complex）' }
    }
    Write-Note ("   抽帧耗时 {0:N2}s" -f $sw.Elapsed.TotalSeconds)
    Write-Event 'progress' @{ pct = 10; text = ("抽帧完成 {0:N1}s" -f $sw.Elapsed.TotalSeconds) }
}

Write-Note "[2/4] OCR ..."
Write-Note "   引擎: $OcrExe"
# 缓存的是「所有识别到的行」（未按 ID 过滤），这样 -LocalId auto 和换 ID 重跑都不用重跑 OCR
$rowsFile = Join-Path $Work 'rows.json'
if ($Reuse -and (Test-Path -LiteralPath $rowsFile)) {
    $rows = @(Get-Content -LiteralPath $rowsFile -Raw | ConvertFrom-Json)
    Write-Note "   复用 rows.json，识别到 $($rows.Count) 行"
    Write-Event 'progress' @{ pct = 65; text = "复用 OCR 结果 $($rows.Count) 行" }
} else {
    $swOcr = [Diagnostics.Stopwatch]::StartNew()
    $rows = [System.Collections.Generic.List[object]]::new()
    $scanned = 0

    # 帧元数据：路径 -> (slot, t)
    $frameMeta = @{}
    $paths = [System.Collections.Generic.List[string]]::new()
    for ($s = 0; $s -lt $slots.Count; $s++) {
        foreach ($f in (Get-ChildItem -LiteralPath (Join-Path $Work "slots\$s") -Filter *.png | Sort-Object Name)) {
            $frameMeta[$f.FullName] = @{ slot = $s; t = ([int]$f.BaseName - 1) / $ScanFps }
            $paths.Add($f.FullName)
        }
    }

    $addRow = {
        param($path, $tsvLine)
        $p = $tsvLine -split "`t"
        if ($p.Count -lt 7) { return }
        $m = $frameMeta[$path]
        $script:rows.Add([pscustomobject]@{
            t = [math]::Round($m.t, 2); slot = $m.slot; text = $p[6]; score = [double]$p[5]; path = $path
        })
    }

    if ($SingleOcr) {
        # 每帧一次进程（旧实现，用于 A/B 对比）
        foreach ($path in $paths) {
            $scanned++
            foreach ($line in (& $OcrExe --models $Models $path 2>$null)) { & $addRow $path $line }
        }
    } else {
        # 批量：路径写进清单，一次进程内处理，模型只加载一次。
        # 但单个长进程会随时间劣化（实测 720 帧一次跑 126-133ms/帧，拆成 6×120 只要 90ms/帧），
        # 所以按 ChunkSize 分段调用。
        $cur = $null
        $scanned = $paths.Count
        $chunkCount = [math]::Ceiling($paths.Count / $ChunkSize)
        for ($c = 0; $c -lt $chunkCount; $c++) {
            $from = $c * $ChunkSize
            $to   = [math]::Min($paths.Count - 1, $from + $ChunkSize - 1)
            $listFile = Join-Path $Work "ocr_list_$c.txt"
            Set-Content -LiteralPath $listFile -Value $paths[$from..$to] -Encoding utf8
            foreach ($line in (& $OcrExe --quiet --models $Models --list $listFile 2>$null)) {
                if ($line.StartsWith("F`t")) { $cur = $line.Substring(2); continue }
                if (-not $cur) { continue }
                & $addRow $cur $line
            }
            $done = [math]::Min($to + 1, $paths.Count)
            $pct = 10 + 55.0 * $done / [math]::Max(1, $paths.Count)
            Write-Event 'progress' @{ pct = [math]::Round($pct, 1); text = "OCR $done/$($paths.Count)" }
        }
    }

    $rows | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $rowsFile -Encoding utf8
    Write-Note ("   识别 {0} 张，得到 {1} 行文本，OCR 耗时 {2:N1}s（单张 {3:N0}ms）" -f `
        $scanned, $rows.Count, $swOcr.Elapsed.TotalSeconds, ($swOcr.Elapsed.TotalMilliseconds / [math]::Max(1, $scanned)))
    Write-Event 'progress' @{ pct = 65; text = ("OCR 完成 {0} 张 / {1} 行，{2:N1}s" -f $scanned, $rows.Count, $swOcr.Elapsed.TotalSeconds) }
}

# ── 行首金框：既用来推断本机 ID，也用来逐行否决（BUGS #1 / TODO #1）──────────
# 本机玩家的头像框是淡黄色：「出现在行首」= 这次击杀是本机打的，「出现在行尾」= 本机被杀。
# 敌方红框、队友青框都不命中这套颜色判据，所以它是「本机 ID 在杀手位」的直接证据，
# 比文本顺序可靠。只对「有文本的行」采样，同一张图只算一次。
Write-Event 'stage' @{ name = 'detect'; pct = 65; text = '重建击杀事件' }
$markerMap = @{}
foreach ($r in $rows) {
    if (-not $r.text -or -not $r.path) { continue }
    if (-not $markerMap.ContainsKey($r.path)) {
        $markerMap[$r.path] = Get-SelfMarkerScore -ImagePath $r.path -Fraction 0.5
    }
}

# 本地玩家 ID：显式指定，或 auto 从「行首金框」的那些行推断
if ($LocalId -eq 'auto') {
    $autoId = Get-AutoLocalId -Rows $rows -MarkerMap $markerMap
    if (-not $autoId) {
        throw '无法自动判定本地玩家 ID（带标记得的击杀样本不足），请用 -LocalId <你的ID> 显式指定'
    }
    $LocalId = $autoId
    Write-Note ("   自动判定本地 ID: {0}" -f $LocalId)
}
Write-Event 'localId' @{ id = $LocalId }

# 文本归一化只能证明「本机 ID 在这一行开头」，证明不了它在杀手位；金框可用时再逐行否决一遍。
$markerOn = Test-SelfMarkerChannel -Scores @($markerMap.Values)
if (-not $markerOn) {
    Write-Note '   !! 行首金框不可用（ROI 没框住头像框 / 图像读不出来），本次退回纯文本判定'
}
$candidates = [System.Collections.Generic.List[object]]::new()
foreach ($r in $rows) {
    $norm = Get-LocalKillText -Text $r.text -LocalId $LocalId
    if (-not $norm -or $norm.Length -lt 3) { continue }
    $marker = if ($markerMap.ContainsKey($r.path)) { $markerMap[$r.path] } else { 0.0 }
    $candidates.Add([pscustomobject]@{
        t = $r.t; slot = $r.slot; text = $norm; score = $r.score; raw = $r.text; marker = $marker
    })
}
$split = if ($markerOn) {
    Select-SelfKillHits -Hits $candidates
} else {
    [pscustomobject]@{ kept = @($candidates); dropped = @() }
}
$hits = @($split.kept)
foreach ($d in @($split.dropped)) {
    Write-Note ("   [否决] {0,7:N2}s 行首无金框  {1}" -f $d.t, ($d.raw | ConvertTo-Json -Compress))
}
$hint = if (@($split.dropped).Count -gt 0) { "（行首无金框否决 $(@($split.dropped).Count) 条）" } else { '' }
Write-Note ("   命中本地玩家击杀的行 {0} 条{1}" -f $hits.Count, $hint)

Write-Note "[3/4] 按屏幕占位重建 -> 击杀事件 ..."
# 判定逻辑见 scripts/lib/events.ps1：killfeed 是队列，同一条文本可以合法地出现多次
# （贤者复活、暮蝶自我复活都会让同一个敌人一回合内被杀多次，一回合最多 7 杀）。
$events = @(ConvertTo-KillEvents -Hits $hits -MergeGap 3.0 -MaxAppearance 6.0)
$events = @(Merge-VariantEvents -Events $events -MaxGap 1.5 -MaxDistance 1)
Write-Note (($events | Format-Table t, slot, score, text -AutoSize | Out-String).TrimEnd())
Write-Event 'kills' @{
    count = $events.Count
    kills = @($events | ForEach-Object { @{ t = $_.t; text = $_.text; slot = $_.slot; score = $_.score } })
}

Write-Note "[4/4] 切片 + 拼接 ..."
# 分段规则见 scripts/lib/events.ps1：合并近距离击杀，并保证段与段之间不重叠
$segs = @(New-HighlightSegments -Events $events -Pre $PRE -Post $POST -MergeGap $MERGE -MaxDuration $MAXSEG)

$listFile = Join-Path $Work 'list.txt'
Remove-Item -LiteralPath $listFile -ErrorAction SilentlyContinue
$swCut = [Diagnostics.Stopwatch]::StartNew()
$i = 0
foreach ($sg in $segs) {
    $i++
    $dur = [math]::Round($sg.end - $sg.start, 2)
    $clipPath = Join-Path $Work ("clips\k{0:d2}.mp4" -f $i)
    Write-Note ("   #{0}  {1,7:N2}s +{2,5:N2}s  {3}" -f $i, $sg.start, $dur, $sg.text)
    & $ff -y -v error -ss $sg.start -i $Source -t $dur `
        -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p `
        -c:a aac -b:a 192k -movflags +faststart $clipPath
    if (-not (Test-Path -LiteralPath $clipPath)) { Write-Note "   !! 切片失败 $clipPath"; continue }
    "file '$($clipPath -replace '\\', '/')'" | Add-Content $listFile
    $pct = if ($segs.Count -gt 0) { 70 + 25.0 * $i / $segs.Count } else { 95 }
    Write-Event 'progress' @{ pct = [math]::Round($pct, 1); text = "切片 $i/$($segs.Count)" }
}

$reel = Join-Path $Work 'highlight_reel.mp4'
& $ff -y -v error -f concat -safe 0 -i $listFile -c copy $reel
Write-Note ("   切片 + 拼接耗时 {0:N1}s" -f $swCut.Elapsed.TotalSeconds)

# ── kills.json（文档 §7.1 的中间接口）──────────────────────────
$meta = [ordered]@{
    source = (Split-Path -Leaf $Source)
    profile = $roiProfile
    width = $srcW; height = $srcH; fps = $srcFps; scan_fps = $ScanFps
    pre = $PRE; post = $POST
    roi = @{ x = $slotX; w = $slotW; h = $slotH; slots = $slots }
}
$meta.kills = @($events | ForEach-Object { [ordered]@{ t = $_.t; text = $_.text; slot = $_.slot; score = $_.score } })
$killsJson = Join-Path $Work 'kills.json'
$meta | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $killsJson -Encoding utf8

if (-not (Test-Path -LiteralPath $reel)) { throw '拼接失败' }

# ── 只把成片交出去：out/<素材名>/highlight_reel.mp4 ─────────────────
$dur = (& ffprobe -v error -show_entries format=duration -of csv=p=0 $reel).Trim()
$durSec = [math]::Round([double]$dur, 2)
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$final = Join-Path $Out 'highlight_reel.mp4'
Copy-Item -LiteralPath $reel -Destination $final -Force
$sizeMb = [math]::Round((Get-Item -LiteralPath $final).Length / 1MB, 1)
$elapsed = [math]::Round($swTotal.Elapsed.TotalSeconds, 1)

Write-Event 'segments' @{
    count = $segs.Count
    segments = @($segs | ForEach-Object { @{ start = [math]::Round($_.start, 2); end = [math]::Round($_.end, 2); text = $_.text } })
}
Write-Event 'result' @{
    output   = $final
    stem     = $stem
    duration = $durSec
    width    = $srcW
    height   = $srcH
    profile  = $roiProfile
    scanFps  = $ScanFps
    localId  = $LocalId
    kills    = $events.Count
    segments = $segs.Count
    sizeMb   = $sizeMb
    elapsed  = $elapsed
}

# 中间产物（抽帧、OCR 结果、切片、kills.json）默认删掉：这些对使用者没有意义
if (-not $KeepWork) {
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
    # 顺手清掉空掉的父目录（<temp>\AutoReel），别在临时目录里留壳
    $workParent = Split-Path -Parent $Work
    if ((Test-Path -LiteralPath $workParent) -and
        -not (Get-ChildItem -LiteralPath $workParent -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $workParent -Force -ErrorAction SilentlyContinue
    }
}

Write-Note ''
Write-Note ("成片: {0}" -f $final)
Write-Note ("      {0} s   {1} 次击杀 → {2} 段   {3:N1} MB   总耗时 {4:N1}s" -f `
    $durSec, $events.Count, $segs.Count, ((Get-Item -LiteralPath $final).Length / 1MB), $swTotal.Elapsed.TotalSeconds)
if ($KeepWork) { Write-Note ("      中间产物: {0}" -f $Work) }
