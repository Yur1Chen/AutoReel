# ConvertTo-KillEvents 的合成用例。
# 现有素材里没有出现「复活后再杀」，所以必须用构造数据验证判定规则。
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\events.ps1')

function New-Hit($t, $slot, $text, $score = 1.0) {
    [pscustomobject]@{ t = [double]$t; slot = $slot; text = $text; score = [double]$score }
}

# 生成一行在 [from, to] 内的命中（0.5s 步长，模拟 2fps）；-Twin 表示同时有两格显示同一条
function New-Frames($text, $from, $to, $slot = 0, [switch]$Twin) {
    $r = @()
    for ($t = $from; $t -le $to + 1e-9; $t += 0.5) {
        $r += New-Hit $t $slot $text
        if ($Twin) { $r += New-Hit $t ($slot + 1) $text }
    }
    return $r
}

$cases = @(
    @{ name = '单次击杀：一行停留 5s'
       hits = (New-Frames 'A' 10 14.5); expect = 1 }
    @{ name = 'OCR 漏帧 2.5s 空档：仍算一次'
       hits = ((New-Frames 'A' 7.5 9) + (New-Frames 'A' 11.5 12)); expect = 1 }
    @{ name = '跨回合重名：间隔 90s'
       hits = ((New-Frames 'A' 10 14) + (New-Frames 'A' 104 108)); expect = 2 }
    @{ name = '复活后再杀：首行过期 1.5s 后重现'
       hits = ((New-Frames 'A' 10 14) + (New-Frames 'A' 15.5 19.5)); expect = 2 }
    @{ name = '复活三连杀：三段各一次'
       hits = ((New-Frames 'A' 50 54) + (New-Frames 'A' 58 62) + (New-Frames 'A' 66 70)); expect = 3 }
    @{ name = '同屏两条同名：slot0 与 slot1 各一条'
       hits = (New-Frames 'A' 30 34 0 -Twin); expect = 2 }
    @{ name = '同屏两条 + 之后又一条：共三次'
       hits = ((New-Frames 'A' 30 34 0 -Twin) + (New-Frames 'A' 36 40)); expect = 3 }
    @{ name = '两个不同受害者同一时刻'
       hits = ((New-Frames 'A' 40 44 0) + (New-Frames 'B' 40 44 1)); expect = 2 }
    @{ name = '上移不重复：条目数恒为 1'
       hits = (New-Frames 'A' 80 84); expect = 1 }
    @{ name = '无命中'
       hits = @(); expect = 0 }
)

$fail = 0
foreach ($c in $cases) {
    $got = @(ConvertTo-KillEvents -Hits $c.hits -MergeGap 3.0 -MaxAppearance 6.0)
    $ok = ($got.Count -eq $c.expect)
    if (-not $ok) { $fail++ }
    "{0}  {1,-32} 期望 {2} 实得 {3}   t = {4}" -f $(if ($ok) { '[PASS]' } else { '[FAIL]' }),
        $c.name, $c.expect, $got.Count, (($got | ForEach-Object { $_.t }) -join ',')
}
""
# ── Get-LocalKillText：前缀匹配 + OCR 容错 ───────────────────────────
$id = '比奇堡恶霸鱼'
$matchCases = @(
    @{ text = '比奇堡恶霸鱼艾斯卡诺';        expect = '比奇堡恶霸鱼艾斯卡诺'; want = $true }
    @{ text = '比奇堡恶霸鱼 being';          expect = '比奇堡恶霸鱼being';    want = $true }
    @{ text = 'IV 比奇堡恶霸鱼 being';       expect = '比奇堡恶霸鱼being';    want = $true }
    @{ text = 'G 比奇堡恶霸鱼原神转瓦偏运动'; expect = '比奇堡恶霸鱼原神转瓦偏运动'; want = $true }
    @{ text = '乐邦詹士9贤者';              expect = '乐邦詹士贤者';        want = $true; id = '乐邦詹士' }
    @{ text = '奇堡恶霸鱼搞事早把爱玩机瞄';   expect = '比奇堡恶霸鱼搞事早把爱玩机瞄'; want = $true }
    @{ text = '乐邦詹士Mete0r4';            expect = '乐邦詹士Mete0r4';     want = $true; id = '乐邦詹士' }
    @{ text = '原神转瓦偏运动比奇堡恶霸鱼';   expect = $null; want = $false }
    @{ text = '总是泪萌萌艾斯卡诺';          expect = $null; want = $false }
    # BUGS #1：本机在受害者位 —— 剥掉敌方拉丁 ID 后只剩本机 ID，必须判成「不是我的击杀」
    @{ text = 'ToneAim 乐邦詹士';           expect = $null; want = $false; id = '乐邦詹士' }
    @{ text = 'ToneAim乐邦詹士';            expect = $null; want = $false; id = '乐邦詹士' }
    @{ text = 'IV 乐邦詹士';                expect = $null; want = $false; id = '乐邦詹士' }
    @{ text = 'G 乐邦詹士';                 expect = $null; want = $false; id = '乐邦詹士' }
    @{ text = '邦詹士';                     expect = $null; want = $false; id = '乐邦詹士' }
    @{ text = '乐邦詹士';                   expect = $null; want = $false; id = '乐邦詹士' }
)
foreach ($c in $matchCases) {
    $useId = if ($c.ContainsKey('id')) { $c.id } else { $id }
    $got = Get-LocalKillText -Text $c.text -LocalId $useId
    $ok = if ($c.want) { $got -eq $c.expect } else { $null -eq $got }
    if (-not $ok) { $fail++ }
    "{0}  {1,-24} → {2}" -f $(if ($ok) { '[PASS]' } else { '[FAIL]' }), $c.text, $(if ($null -eq $got) { '(不是本机击杀)' } else { $got })
}
""
# ── 行首金框：逐行否决（BUGS #1 治本 / TODO #1 撞名）──────────────────
# 同一条文本，金框在行首才是本机的击杀；金框缺 → 敌方/队友在杀手位，一律否决。
function New-MarkedFrames($text, $from, $to, $marker, $slot = 0) {
    $r = @()
    for ($t = $from; $t -le $to + 1e-9; $t += 0.5) {
        $h = New-Hit $t $slot $text
        $h | Add-Member -NotePropertyName marker -NotePropertyValue ([double]$marker)
        $r += $h
    }
    return $r
}
$markerCases = @(
    @{ name = '金框在（3.8）→ 保留 1 次'
       hits = (New-MarkedFrames '乐邦詹士香甜小蝶' 10 12 3.8); expect = 1 }
    @{ name = '敌方行（0.0）→ 否决'
       hits = (New-MarkedFrames '乐邦詹士' 10 12 0.0); expect = 0 }
    @{ name = '淡入帧（0.232）→ 保留 1 次'
       hits = (New-MarkedFrames '乐邦詹士香甜小蝶' 10 12 0.232); expect = 1 }
    @{ name = '缺 marker 字段 → 视作 0 → 否决'
       hits = (New-Frames '乐邦詹士香甜小蝶' 10 12); expect = 0 }
    @{ name = '撞名：我杀同名人（3.8）→ 1 次'
       hits = (New-MarkedFrames '乐邦詹士乐邦詹士' 10 12 3.8); expect = 1 }
    @{ name = '撞名：同名人杀我（0.0）→ 0 次'
       hits = (New-MarkedFrames '乐邦詹士乐邦詹士' 10 12 0.0); expect = 0 }
    @{ name = '撞名：敌杀别人的名字以我开头（0.0）→ 0 次'
       hits = (New-MarkedFrames '乐邦詹士香甜小蝶' 10 12 0.0); expect = 0 }
)
foreach ($c in $markerCases) {
    $split = Select-SelfKillHits -Hits $c.hits
    $got = @(ConvertTo-KillEvents -Hits $split.kept -MergeGap 3.0 -MaxAppearance 6.0)
    $ok = ($got.Count -eq $c.expect)
    if (-not $ok) { $fail++ }
    "{0}  {1,-34} 期望 {2} 实得 {3}（否决 {4} 行）" -f $(if ($ok) { '[PASS]' } else { '[FAIL]' }),
        $c.name, $c.expect, $got.Count, @($split.dropped).Count
}
$channelCases = @(
    @{ name = '有行过 3.0 → 通道可用'; scores = @(0, 0.232, 3.7); expect = $true }
    @{ name = '全 0（ROI 没框到金框）→ 不可用'; scores = @(0, 0, 0.232); expect = $false }
    @{ name = '没有样本 → 不可用'; scores = @(); expect = $false }
)
foreach ($c in $channelCases) {
    $got = Test-SelfMarkerChannel -Scores $c.scores
    $ok = ($got -eq $c.expect)
    if (-not $ok) { $fail++ }
    "{0}  {1,-34} 期望 {2} 实得 {3}" -f $(if ($ok) { '[PASS]' } else { '[FAIL]' }), $c.name, $c.expect, $got
}
""
# ── Merge-VariantEvents：同一次击杀的 OCR 变体 ─────────────────────
$variantCases = @(
    @{ name = '同一击杀两种写法：差一个字母、相隔 0.5s'
       hits = ((New-Frames '比奇堡恶霸鱼being' 103 107) + (New-Frames '比奇堡恶霸鱼Gbeing' 103.5 104))
       expect = 1 }
    @{ name = '两个不同受害者同时出现（文本差异大）'
       hits = ((New-Frames '比奇堡恶霸鱼艾斯卡诺' 40 44) + (New-Frames '比奇堡恶霸鱼搞事早把爱玩机瞄' 40.5 44))
       expect = 2 }
    @{ name = '不同受害者名字相近（距离 2）不能误并'
       hits = ((New-Frames '乐邦詹士雨滴小熊' 17 21) + (New-Frames '乐邦詹士心碎小熊' 17.5 21))
       expect = 2 }
    @{ name = '同屏两条同名（文本相同）不受影响'
       hits = (New-Frames '比奇堡恶霸鱼being' 30 34 0 -Twin)
       expect = 2 }
)
foreach ($c in $variantCases) {
    $ev = @(Merge-VariantEvents -Events @(ConvertTo-KillEvents -Hits $c.hits) -MaxGap 1.5)
    $ok = ($ev.Count -eq $c.expect)
    if (-not $ok) { $fail++ }
    "{0}  {1,-32} 期望 {2} 实得 {3}" -f $(if ($ok) { '[PASS]' } else { '[FAIL]' }), $c.name, $c.expect, $ev.Count
}
""
# ── Get-LocalIdFromTexts：从行首黄框的文本推断本机 ID ────────────────
$idCases = @(
    @{ name = '三种不同受害者 → 取公共前缀'
       texts = @('乐邦詹士Mete0r4','乐邦詹士困了又困','乐邦詹士心碎小熊'); expect = '乐邦詹士' }
    @{ name = '带图标噪声也归一后取前缀'
       texts = @('比奇堡恶霸鱼being','IV 比奇堡恶霸鱼艾斯卡诺','m 比奇堡恶霸鱼搞事早把爱玩机瞄'); expect = '比奇堡恶霸鱼' }
    @{ name = '只有一个样本 → 不可信'
       texts = @('乐邦詹士Mete0r4'); expect = $null }
    @{ name = '两条完全相同 → 不可信'
       texts = @('乐邦詹士Mete0r4','乐邦詹士Mete0r4'); expect = $null }
    @{ name = '受害者同名导致前缀吃进受害者 → 拒绝'
       texts = @('乐邦詹士abc','乐邦詹士abc'); expect = $null }
    @{ name = '混入两条误检也不影响推断'
       texts = @('乐邦詹士Mete0r4','乐邦詹士困了又困','乐邦詹士雨滴小熊','别的不相干','金色传说'); expect = '乐邦詹士' }
)
foreach ($c in $idCases) {
    $got = Get-LocalIdFromTexts -Texts $c.texts
    $ok = if ($null -eq $c.expect) { $null -eq $got } else { $got -eq $c.expect }
    if (-not $ok) { $fail++ }
    "{0}  {1,-34} 期望 {2} 实得 {3}" -f $(if ($ok) { '[PASS]' } else { '[FAIL]' }), $c.name, $(if ($null -eq $c.expect) { '(拒绝)' } else { $c.expect }), $(if ($null -eq $got) { '(拒绝)' } else { $got })
}
""
# ── New-HighlightSegments：分段与前摇后摇 ───────────────────────────
function New-Ev($t, $text = 'x') { [pscustomobject]@{ t = [double]$t; slot = 0; text = $text; score = 1.0 } }
$segCases = @(
    @{ name = '相隔 4.5s 并成一段（前摇+后摇=5.0）'
       events = @((New-Ev 113.0), (New-Ev 117.5)); expectSegs = 1; gap = 5.0 }
    @{ name = '相隔 5.5s 分成两段且无重叠'
       events = @((New-Ev 113.0), (New-Ev 118.5)); expectSegs = 2; gap = 5.0 }
    @{ name = '相隔 4.0s 并成一段'
       events = @((New-Ev 100.0), (New-Ev 104.0)); expectSegs = 1; gap = 5.0 }
    @{ name = '相隔 9s 分成两段且无重叠'
       events = @((New-Ev 50.0), (New-Ev 59.0)); expectSegs = 2; gap = 5.0 }
    @{ name = '阈值 4.5 时 4.5s 间隔不合并（回归保护）'
       events = @((New-Ev 113.0), (New-Ev 117.5)); expectSegs = 2; gap = 4.5 }
    @{ name = '上限截断后仍保留最后一杀的后摇'
       events = @((New-Ev 109.5), (New-Ev 113.0), (New-Ev 117.5)); expectSegs = 1; gap = 5.0; expectEnd = 119.0 }
    @{ name = '开头不足前摇的击杀被丢弃'
       events = @((New-Ev 2.0), (New-Ev 40.0)); expectSegs = 1; gap = 5.0 }
)
foreach ($c in $segCases) {
    $sg = @(New-HighlightSegments -Events $c.events -Pre 3.5 -Post 1.5 -MergeGap $c.gap -MaxDuration 12.0)
    $overlap = $false
    for ($i = 0; $i -lt $sg.Count - 1; $i++) { if ($sg[$i].end -gt $sg[$i + 1].start + 1e-9) { $overlap = $true } }
    $ok = ($sg.Count -eq $c.expectSegs) -and (-not $overlap)
    if ($ok -and $c.ContainsKey('expectEnd')) { $ok = ([math]::Abs($sg[$sg.Count - 1].end - $c.expectEnd) -lt 1e-6) }
    if (-not $ok) { $fail++ }
    $endInfo = if ($sg.Count -gt 0) { [math]::Round($sg[$sg.Count - 1].end, 2) } else { '-' }
    "{0}  {1,-30} 段数 {2}（期望 {3}） 重叠={4} 末段终点={5}" -f $(if ($ok) { '[PASS]' } else { '[FAIL]' }), $c.name, $sg.Count, $c.expectSegs, $overlap, $endInfo
}
""
if ($fail -gt 0) { "失败 $fail 项"; exit 1 } else { "全部通过（事件 $($cases.Count) + 匹配 $($matchCases.Count) + 金框 $($markerCases.Count + $channelCases.Count) + 变体 $($variantCases.Count) + ID 推断 $($idCases.Count) + 分段 $($segCases.Count)）" }
