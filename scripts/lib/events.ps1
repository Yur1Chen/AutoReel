# 把 OCR 命中（每帧每条击杀栏的文本）重建成击杀事件。
#
# killfeed 是一个队列：新击杀追加到下方，旧条目过期后整体上移，一行停留 4-5s。
# 所以「按文本去重」是错的判定：贤者（奶妈）的复活、暮蝶的自我复活，会让同一个敌人
# 在同一回合里被同一个人杀多次，文本完全一样（一回合理论上最多 7 杀）。
#
# 判定规则看「屏幕占位」：
#   1. 对每条文本，把它的命中时间切成若干「连续出现的时段」，时段内部允许 ≤ MergeGap 的
#      OCR 漏帧（实测单次停留内会出现 2.5s 空档）；
#   2. 每个时段产出「该时段内同时在屏的最大条数」个事件 —— 同一时刻屏幕上有两格是同一条
#      文本，就是实实在在的两次击杀；
#   3. 单纯的整体上移不会改变条目数，因此不会被重复计。
#
# 这样：跨回合重名 / 复活后再杀（时段间隔大）→ 多次；同屏两条同名 → 两次；
#       OCR 漏帧（时段内空档）→ 仍算一次。
# 判断一条 killfeed 文本是不是「本地玩家的击杀」，并返回可用于分组的归一化文本。
#
# killfeed 一行是「杀手名 + 被杀者名」连写，所以必须做前缀匹配：用 Contains 会把
# 「敌人把我杀了」（<敌人名><我的ID>）也算成本地玩家的击杀（文档 §6 坑 2）。
#
# 但纯前缀匹配又会漏，实测两种 OCR 偏差（文档 §9 也提到非 ASCII 名字会被识别成同形字）：
#   1. 开头的武器/头像图标被读成字母：`IV 比奇堡恶霸鱼 being`、`G 比奇堡恶霸鱼 ...`
#   2. 首字漏识别：`奇堡恶霸鱼搞事早把爱玩机瞄`（本应是 `比奇堡恶霸鱼…`）
# 因此先剥掉开头的非汉字噪声，再允许「本地 ID 去掉首字」作为前缀；命中后把漏掉的首字补回去，
# 让两种写法归一到同一个分组键，避免同一条击杀被当成两条。
#
# 不是本地玩家击杀时返回 $null。
function Get-LocalKillText {
    param(
        [Parameter(Mandatory)] [string] $Text,
        [Parameter(Mandatory)] [string] $LocalId
    )

    $id = $LocalId -replace '[\s\p{P}]', ''
    if (-not $id) { return $null }

    $key = $Text -replace '[\s\p{P}]', ''
    if ($id -match '^[\p{IsCJKUnifiedIdeographs}]') {
        # 只对中文 ID 剥前缀噪声；英文 ID 的正文本身就是字母，剥完就空了
        $key = $key -replace '^[^\p{IsCJKUnifiedIdeographs}]+', ''
    }
    if (-not $key) { return $null }

    # 夹在两个汉字之间的单个字母/数字是 OCR 噪声（武器图标、准星读数等）：
    # 实测 `乐邦詹士贤者` 会被读成 `乐邦詹士9贤者`，不归一会同一行变成两个文本、
    # 从而被当成两次击杀。英文受害者名（如 `Mete0r4`）不受影响，因为那里的字母两侧不是汉字。
    $key = $key -replace '(?<=[\p{IsCJKUnifiedIdeographs}])[0-9A-Za-z](?=[\p{IsCJKUnifiedIdeographs}])', ''
    if (-not $key) { return $null }

    # 不变量：归一化后必须还剩下受害者。真击杀 = 本机 ID + 受害者，剥完至少还剩 1 个字符；
    # 剩下的正好只有本机 ID 时，本机是「被击杀方」——例如 `ToneAim 乐邦詹士`：
    # ToneAim 是敌方拉丁 ID，被上面那条「剥开头非汉字噪声」整段吃掉，剩 `乐邦詹士`，
    # 于是前缀匹配成立、受害者却是空的（BUGS #1）。这里直接判为不是本机的击杀。
    if ($key.StartsWith($id)) {
        if ($key.Length -le $id.Length) { return $null }
        return $key
    }

    if ($id.Length -ge 3 -and $key.StartsWith($id.Substring(1))) {
        $restored = $id.Substring(0, 1) + $key
        # 同理：补回首字后仍等于本机 ID，说明受害者段整个丢了（`邦詹士` → `乐邦詹士`）
        if ($restored.Length -le $id.Length) { return $null }
        return $restored
    }
    return $null
}

# 两个字符串的编辑距离（Levenshtein），用于识别同一击杀的 OCR 变体。
function Get-TextDistance {
    param([string] $A, [string] $B)
    $n = $A.Length; $m = $B.Length
    if ($n -eq 0) { return $m }
    if ($m -eq 0) { return $n }
    $prev = New-Object 'int[]' ($m + 1)
    $cur  = New-Object 'int[]' ($m + 1)
    for ($j = 0; $j -le $m; $j++) { $prev[$j] = $j }
    for ($i = 1; $i -le $n; $i++) {
        $cur[0] = $i
        for ($j = 1; $j -le $m; $j++) {
            $cost = if ($A[$i - 1] -eq $B[$j - 1]) { 0 } else { 1 }
            $cur[$j] = [math]::Min([math]::Min($cur[$j - 1] + 1, $prev[$j] + 1), $prev[$j - 1] + $cost)
        }
        $tmp = $prev; $prev = $cur; $cur = $tmp
    }
    return $prev[$m]
}

# 合并「同一次击杀的不同 OCR 写法」。
# 武器/头像图标会被 OCR 成字母混进名字里（实测 `比奇堡恶霸鱼 being` 与
# `比奇堡恶霸鱼 G being` 是同一条击杀），不合并就会把一次击杀算成两次。
# 只合并「文本不同、时间相近、编辑距离很小」的事件；文本完全相同的不动，
# 那是同屏两条真实击杀，由 ConvertTo-KillEvents 的占位计数负责。
function Merge-VariantEvents {
    param(
        $Events,
        [double] $MaxGap = 1.5,
        # 只允许差 1 个字符：实测图标噪声是单个字母（`being` vs `Gbeing`）。
        # 放到 2 会把「乐邦詹士雨滴小熊」和「乐邦詹士心碎小熊」这种不同受害者误并
        # （两者编辑距离正好 2），所以这条不能松。
        [int]    $MaxDistance = 1
    )
    $kept = [System.Collections.Generic.List[object]]::new()
    foreach ($e in @($Events | Sort-Object t)) {
        $dup = $false
        foreach ($k in $kept) {
            if ($k.text -ne $e.text -and
                [math]::Abs($k.t - $e.t) -le $MaxGap -and
                (Get-TextDistance $k.text $e.text) -le $MaxDistance) {
                $dup = $true
                break
            }
        }
        if (-not $dup) { $kept.Add($e) }
    }
    return @($kept | Sort-Object t)
}

# ── 自动判定本地玩家 ID ─────────────────────────────────────────────
#
# 游戏会把「本机玩家」的头像框画成淡黄色（其余队友青、敌方红）。框出现在行首 =
# 这次击杀是本机打的；出现在行尾 = 本机被击杀。因此只要采集「行首黄框」的那些行，
# 取它们文本的公共前缀，就是本机 ID（受害者各不相同，前缀自然收敛到杀手名）。
#
# 实测（2026.10.13 素材，ROI 放宽到 760px 后）：本机击杀行左区黄占比 5.5%–，本机死亡行
# 右区 7.4%–，其余绝大多数为 0，阈值取 3% 即可分开。

# 行首金框的判定阈值（%）：推断本机 ID 与逐行否决共用同一个值。
$script:SelfMarkerMinScore = 3.0
# 逐行否决的阈值（%）。故意压到很低，只用来区分「有没有金框」：
# 本素材 39 个真击杀行的最低值是淡入瞬间的 0.232，敌方行恒为 0.000，
# 所以 0.1 既能挡住敌方行，又不会把淡入那一帧真击杀丢掉。
$script:SelfMarkerVeto = 0.1

# 计算一张击杀条裁剪图左端（行首头像框）的淡黄像素占比。
function Get-SelfMarkerScore {
    param(
        [Parameter(Mandatory)] [string] $ImagePath,
        [double] $Fraction = 0.30,
        [int] $Stride = 3
    )
    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
    $b = [System.Drawing.Bitmap]::new($ImagePath)
    try {
        $xMax = [int]($b.Width * $Fraction)
        $hit = 0; $tot = 0
        for ($px = 0; $px -lt $xMax; $px += $Stride) {
            for ($py = 0; $py -lt $b.Height; $py += $Stride) {
                $c = $b.GetPixel($px, $py)
                $tot++
                if ($c.R -ge 185 -and $c.G -ge 185 -and $c.B -le 165 -and
                    ($c.R - $c.B) -ge 55 -and ($c.G - $c.B) -ge 55 -and
                    [math]::Abs($c.R - $c.G) -le 35) { $hit++ }
            }
        }
        if ($tot -eq 0) { return 0 }
        return 100.0 * $hit / $tot
    } finally { $b.Dispose() }
}

function Get-CommonPrefix {
    param([string[]] $Strings)
    if (-not $Strings -or $Strings.Count -eq 0) { return '' }
    $p = $Strings[0]
    foreach ($s in $Strings) {
        $i = 0
        while ($i -lt $p.Length -and $i -lt $s.Length -and $p[$i] -eq $s[$i]) { $i++ }
        $p = $p.Substring(0, $i)
        if (-not $p) { break }
    }
    return $p
}

# 从「行首带黄框」的文本里推断本机 ID。纯函数，便于测试。
#
# 不用「全体候选的公共前缀」：只要混进一条误检（个别素材里会有黄值很高的非本机行），
# 公共前缀就会被拉短到 1 个字符。改为「取支持度最高的公共前缀」——两两取最长公共前缀，
# 再用它去统计有多少候选支持，离群点自然被稀释掉。
function Get-LocalIdFromTexts {
    param(
        [string[]] $Texts,
        [int]      $MinSamples = 2
    )
    $distinct = @(
        $Texts |
        ForEach-Object { ($_ -replace '[\s\p{P}]', '') -replace '^[^\p{IsCJKUnifiedIdeographs}]+', '' } |
        Where-Object { $_ } |
        Select-Object -Unique
    )
    if ($distinct.Count -lt $MinSamples) { return $null }

    $best = $null; $bestSupport = 0
    foreach ($a in $distinct) {
        foreach ($b in $distinct) {
            if ($a -ceq $b) { continue }
            $p = Get-CommonPrefix @($a, $b)
            if ($p.Length -lt 2) { continue }
            $support = @($distinct | Where-Object { $_.StartsWith($p) }).Count
            # 前缀不能等于「支持它的某条文本」：那说明这段公共部分把受害者也吃进去了。
            # 注意只能看支持者，无关的等长离群点不该否决（例如前缀 4 字，另有 4 字的误检行）。
            if (@($distinct | Where-Object { $_.StartsWith($p) -and $_.Length -eq $p.Length }).Count -gt 0) { continue }
            if ($support -gt $bestSupport -or ($support -eq $bestSupport -and $p.Length -gt $best.Length)) {
                $best = $p; $bestSupport = $support
            }
        }
    }
    if (-not $best) { return $null }
    if ($bestSupport -lt $MinSamples) { return $null }
    return $best
}

# 收集「行首黄框」的行，再推断本机 ID；样本不足或前缀不可信时返回 $null。
# -MarkerMap（路径 -> 占比）可由调用方预先算好，省掉每行重算一遍像素。
function Get-AutoLocalId {
    param(
        $Rows,
        [double] $MinScore = 3.0,
        [double] $WindowFraction = 0.5,
        [int]    $MinSamples = 2,
        $MarkerMap = $null
    )
    $texts = [System.Collections.Generic.List[string]]::new()
    foreach ($r in $Rows) {
        if (-not $r.text -or -not $r.path) { continue }
        $score = if ($MarkerMap -and $MarkerMap.ContainsKey($r.path)) {
            $MarkerMap[$r.path]
        } else {
            Get-SelfMarkerScore -ImagePath $r.path -Fraction $WindowFraction
        }
        if ($score -lt $MinScore) { continue }
        $texts.Add($r.text)
    }
    return Get-LocalIdFromTexts -Texts $texts -MinSamples $MinSamples
}

# 「行首金框」这个信号在本素材里是否可用。
#
# 金框只出现在「本机在杀手位」的行上（敌方红框、队友青框都不命中这套颜色判据），
# 但 ROI 没框住头像框、或图像读不出来时，所有分数都是 0——这时如果照着 0 去否决，
# 会把整条素材的击杀全砍掉。所以先看有没有任何一行的分数过 -MinScore，
# 没有就退回纯文本判定（并告警），别静默把成片剪空。
function Test-SelfMarkerChannel {
    param(
        $Scores,
        [double] $MinScore = 3.0,
        [int]    $MinSamples = 1
    )
    $seen = 0
    foreach ($s in @($Scores)) {
        if ($null -ne $s -and [double]$s -ge $MinScore) {
            $seen++
            if ($seen -ge $MinSamples) { return $true }
        }
    }
    return $false
}

# 由击杀事件生成切片区间。
# 前摇 Pre / 后摇 Post，间隔小于 MergeGap 的连续击杀并成一段交战。
# 关键约束：段与段之间不允许重叠——两次击杀相隔 4.5–5.0s 时，后者前摇会早于前者后摇，
# 不钳制就会把同一帧剪进两个切片、成片里同一段画面出现两次（实测 2025.09.21 素材：
# 113.0 与 117.5 两次击杀，后摇到 114.5、前摇从 114.0 开始，重叠 0.5s）。
function New-HighlightSegments {
    param(
        $Events,
        [double] $Pre = 3.5,
        [double] $Post = 1.5,
        [double] $MergeGap = 4.5,
        [double] $MaxDuration = 12.0,
        [double] $MinStart = 0
    )
    $segs = [System.Collections.Generic.List[object]]::new()
    foreach ($e in @($Events | Sort-Object t)) {
        if ($e.t -lt $Pre + 1) { continue }      # 录像开头没有足够前摇，剪不出完整一段
        if ($segs.Count -gt 0 -and ($e.t - $segs[-1].lastT) -lt $MergeGap) {
            $segs[-1].end = [math]::Min($e.t + $Post, $segs[-1].start + $MaxDuration)
            $segs[-1].lastT = $e.t
            $segs[-1].text += " + $($e.text)"
            continue
        }
        $segs.Add([pscustomobject]@{
            start = [math]::Max($MinStart, $e.t - $Pre)
            end   = $e.t + $Post
            lastT = $e.t
            text   = $e.text
        })
    }
    # MaxDuration 只用来抑制「一路并下去」的无限增长，不能把最后一杀的后摇也吃掉
    foreach ($sg in $segs) {
        if ($sg.end -lt $sg.lastT + $Post) { $sg.end = $sg.lastT + $Post }
    }
    # 钳掉段间重叠（后一段的起点是硬边界，优先于上一段的延长）
    for ($i = 0; $i -lt $segs.Count - 1; $i++) {
        if (($segs[$i].end - $segs[$i + 1].start) -gt 1e-9) { $segs[$i].end = $segs[$i + 1].start }
    }
    return @($segs)
}

# 用行首金框逐行否决「本机击杀」候选（BUGS #1 的治本那一条）。
#
# 文本只能证明「本机 ID 出现在这一行的开头」，证明不了它就在杀手位：本机 ID 是别人名字的
# 前缀、或敌方拉丁 ID 被当成图标噪声剥掉，都会让「敌人杀我」看起来像「我杀人」。
# 金框是屏幕上的直接证据，所以这里按行再筛一遍；被否掉的原始行一并返回，方便打日志核对。
function Select-SelfKillHits {
    param(
        $Hits,
        [double] $MinMarker = 0.1
    )
    $kept = [System.Collections.Generic.List[object]]::new()
    $dropped = [System.Collections.Generic.List[object]]::new()
    foreach ($h in @($Hits)) {
        $m = if ($null -ne $h.marker) { [double]$h.marker } else { 0.0 }
        if ($m -ge $MinMarker) { $kept.Add($h) } else { $dropped.Add($h) }
    }
    return [pscustomobject]@{ kept = @($kept); dropped = @($dropped) }
}

function ConvertTo-KillEvents {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Hits,
        [double] $MergeGap = 3.0,
        [double] $MaxAppearance = 6.0
    )

    $events = [System.Collections.Generic.List[object]]::new()
    if (-not $Hits) { return @() }

    foreach ($grp in ($Hits | Group-Object text)) {
        $perFrame = @{}   # t -> 该帧同时在屏的条数
        $slotAt   = @{}   # t -> 槽位
        $scoreAt  = @{}   # t -> 最高分

        foreach ($h in $grp.Group) {
            $n = if ($perFrame.ContainsKey($h.t)) { $perFrame[$h.t] } else { 0 }
            $perFrame[$h.t] = $n + 1
            if (-not $slotAt.ContainsKey($h.t)) { $slotAt[$h.t] = $h.slot }
            $s = if ($scoreAt.ContainsKey($h.t)) { $scoreAt[$h.t] } else { 0.0 }
            $scoreAt[$h.t] = [math]::Max([double]$s, [double]$h.score)
        }

        $times = @($perFrame.Keys | Sort-Object)
        $start = $times[0]
        $maxCount = $perFrame[$times[0]]
        $prev = $times[0]

        for ($i = 1; $i -le $times.Count; $i++) {
            $t = if ($i -lt $times.Count) { $times[$i] } else { $null }
            # 三种情况都要断开：
            #   间隔过大（跨回合 / 复活后再杀 / 屏幕清空）→ 新的一次出现；
            #   单次出现持续超过 MaxAppearance → 一行不可能停留这么久，必然是两次出现首尾相接
            #   （例如第一行过期后 1.5s 又出现同样一行：间隔只有 1.5s，但总时长 9s）。
            $close = ($null -eq $t) -or (($t - $prev) -gt $MergeGap) -or (($t - $start) -gt $MaxAppearance)

            if ($close) {
                for ($k = 0; $k -lt $maxCount; $k++) {
                    $events.Add([pscustomobject]@{
                        t     = [math]::Round($start, 2)
                        slot  = $slotAt[$start]
                        text  = $grp.Name
                        score = $scoreAt[$start]
                    })
                }
                if ($null -ne $t) { $start = $t; $maxCount = $perFrame[$t] }
            } elseif ($perFrame[$t] -gt $maxCount) {
                $maxCount = $perFrame[$t]
            }
            if ($null -ne $t) { $prev = $t }
        }
    }

    return @($events | Sort-Object t)
}
