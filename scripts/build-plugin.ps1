#Requires -Version 7.0
<#
.SYNOPSIS
  把 plugin/ 打成一个可分发的 .tgz（自带引擎、kfocr 与 OCR 模型）。

.DESCRIPTION
  DSH 的 bundle 安装器接受 .tgz：对方在插件页填这个文件的绝对路径即可安装。
  本仓库的插件默认指向 <repo>/scripts、<repo>/kfocr、D:\AIworks\Tack\models —— 都在包外，
  所以打包时把这三样复制进包内，并让插件优先使用包内副本（见 index.js 的 resolveConfig）。

  产物：dist/auto-reel-<version>.tgz，根目录是 npm 风格的 package/。

.PARAMETER NoModels
  不把 31 MB 的 OCR 模型打进包（实测 27.1 MB → 2.2 MB）。此时对方必须自备模型并通过
  配置项 modelsDir 或环境变量 TACK_OCR_MODELS 指出来。

.PARAMETER Models
  模型目录，默认取环境变量 TACK_OCR_MODELS，再退回作者机器的 D:\AIworks\Tack\target\release\models。
#>
param(
    [switch] $NoModels,
    [string] $Models = $env:TACK_OCR_MODELS
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $repo 'plugin'
$dist = Join-Path $repo 'dist'
$stage = Join-Path $dist 'stage'
$pkg = Join-Path $stage 'package'

$version = '0.2.0'

function Copy-Tree([string]$From, [string]$To) {
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    Copy-Item -Path (Join-Path $From '*') -Destination $To -Recurse -Force
}

function Write-Utf8([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

Write-Host "[1/5] 清理 dist ..."
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pkg | Out-Null

Write-Host "[2/5] 复制插件代码 ..."
foreach ($entry in @('index.js', 'client.js', 'cordis.patch.yml', 'icon.svg')) {
    Copy-Item -LiteralPath (Join-Path $plugin $entry) -Destination $pkg -Force
}
foreach ($dir in @('lib', 'locale', 'docs')) {
    Copy-Tree (Join-Path $plugin $dir) (Join-Path $pkg $dir)
}

Write-Host "[3/5] 复制引擎与二进制 ..."
Copy-Tree (Join-Path $repo 'scripts') (Join-Path $pkg 'engine')
# 引擎只保留两个实现与它们依赖的库；构建脚本和测试脚本不进包
$engineKeep = @(
    'highlight.ps1', 'events.ps1',
    'highlight.mjs', 'events.mjs', 'proc.mjs', 'roi.mjs', 'round.mjs'
)
Get-ChildItem -LiteralPath (Join-Path $pkg 'engine') -Recurse -File |
    Where-Object { $_.Name -notin $engineKeep } |
    Remove-Item -Force
New-Item -ItemType Directory -Force -Path (Join-Path $pkg 'bin') | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'kfocr\target\release\kfocr.exe') -Destination (Join-Path $pkg 'bin') -Force

if (-not $NoModels) {
    if (-not $Models) { $Models = 'D:\AIworks\Tack\target\release\models' }
    if (-not (Test-Path -LiteralPath $Models)) {
        throw "找不到 OCR 模型目录: $Models（用 -Models <目录> 或环境变量 TACK_OCR_MODELS 指定，或加 -NoModels）"
    }
    Copy-Tree $Models (Join-Path $pkg 'models')
}

Write-Host "[4/5] 写 package.json / LICENSE / NOTICE / README ..."
$manifest = Get-Content -LiteralPath (Join-Path $plugin 'package.json') -Raw | ConvertFrom-Json
$manifest.PSObject.Properties.Remove('private')
$manifest | Add-Member -NotePropertyName version -NotePropertyValue $version -Force
$manifest | Add-Member -NotePropertyName license -NotePropertyValue 'MIT' -Force
$manifest | Add-Member -NotePropertyName engines -NotePropertyValue ([pscustomobject]@{ dsh = '^0.2.2-rc.3' }) -Force
$files = @('index.js', 'client.js', 'lib', 'cordis.patch.yml', 'locale', 'docs', 'icon.svg', 'engine', 'bin',
           'README.md', 'LICENSE', 'LICENSE-APACHE', 'NOTICE', 'THIRD_PARTY.md')
if (-not $NoModels) { $files += 'models' }
$manifest | Add-Member -NotePropertyName files -NotePropertyValue $files -Force
Write-Utf8 (Join-Path $pkg 'package.json') ($manifest | ConvertTo-Json -Depth 10)

# Apache-2.0 全文与第三方登记：模型权重是 PP-OCRv6 Small（Apache-2.0），随包分发时要带上
Copy-Item -LiteralPath (Join-Path $repo 'third_party\LICENSE-APACHE') -Destination (Join-Path $pkg 'LICENSE-APACHE') -Force
Copy-Item -LiteralPath (Join-Path $repo 'THIRD_PARTY.md') -Destination (Join-Path $pkg 'THIRD_PARTY.md') -Force

$license = @'
MIT License

Copyright (c) 2026 AutoReel contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'@
Write-Utf8 (Join-Path $pkg 'LICENSE') $license

# NOTICE：Apache-2.0 §4(d) 要求随分发附带归因与修改说明
$modelsIncluded = if ($NoModels) { '本包**不含**模型权重（用 -NoModels 打的包）。' } else {
    '本包包含 PP-OCRv6 Small 权重（models/det.rten、models/rec.rten、models/ppocrv6_dict.txt）。'
}
$notice = @"
AutoReel
Copyright (c) 2026 AutoReel contributors

本产品包含以下第三方组件：

1. Tack（tack-ocr 与 tack-core::punct 的源码快照）
   Copyright (c) 2026 Tack contributors
   Licensed under the MIT License OR the Apache License, Version 2.0.
   本包内为 engine/ 中的编译产物与源码快照，见仓库 third_party/。

2. PP-OCRv6 Small 模型权重（det.rten / rec.rten / ppocrv6_dict.txt）
   Copyright (c) PaddlePaddle Authors / Baidu
   Licensed under the Apache License, Version 2.0.
   来源：https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det
         https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec
   修改：转换为 rten（.rten）格式，仅用于文本行检测与识别。
   完整许可全文见本包 LICENSE-APACHE，第三方登记见 THIRD_PARTY.md。

$modelsIncluded

"@
Write-Utf8 (Join-Path $pkg 'NOTICE') $notice

$modelsNote = if ($NoModels) {
    '本包**不含** OCR 模型：请自备 det.rten / rec.rten / ppocrv6_dict.txt（PP-OCRv6 Small，Apache-2.0），然后在插件配置里设 modelsDir（或设环境变量 TACK_OCR_MODELS）。'
} else {
    '本包已自带 OCR 模型（models/ 目录，PP-OCRv6 Small，Apache-2.0）与 kfocr.exe（bin/ 目录），装好即可运行；许可全文见 LICENSE-APACHE，归因见 NOTICE。'
}

$readme = @'
# AutoReel 击杀集锦（DSH 插件）

把 NVIDIA 即时回放剪成 Valorant 击杀集锦：抽帧 → 击杀信息栏 OCR → 重建击杀事件 → 切片 → 拼接。
成片出现在对话的工具卡片里，可播放、可拖进度、可一键用文件管理器打开。

## 安装

1. 拿到本插件的 .tgz；
2. 在 DeepSeek Harness 的**插件**页选择添加插件，填这个 .tgz 的**绝对路径**；
   或让 agent 用 plugin_manager 的 install_bundle 指向它。

## 运行前需要

| 依赖 | 说明 |
|---|---|
| Windows | 仅在 Windows 上验证过 |
| Node / Electron | 由 DSH 自带（JS 引擎默认用它跑，不用另装 node） |
| PowerShell 7 | **可选**：只有 `engine: ps`（或 auto 回落）时才需要 pwsh 在 PATH 中 |
| ffmpeg 9 | ffmpeg / ffprobe 在 PATH 中（不随包分发，约 212 MB） |
| kfocr + 模型 | 见下一节 |

__MODELS_NOTE__

装好后可访问 /autoreel/api/health 逐项自检（会点名缺哪一项）。
也可以在**右侧栏**打开 AutoReel 卡片：选回放、输出目录、击杀前后秒数，直接「剪这条回放」；
设置保存在 `%LOCALAPPDATA%\AutoReel\settings.json`，即时生效、不用重启。

## 分辨率自适应

每次运行先用 ffprobe 读源画面，按「高度相对 1440p 等比缩放 + 贴右边缘」自动算击杀条 ROI，
1080p / 2K / 4K / 21:9 都不用额外配置。游戏内 HUD 缩放调过、自动 ROI 识别不到击杀时，
用 roi 参数（"x,w,h,y1,y2,y3"，源视频像素）显式覆盖。

## 配置

    - id: auto-reel
      name: '@local/auto-reel'
      config:
        replaysDir: 'D:\Videos\VALORANT'   # 默认 %USERPROFILE%\Videos\VALORANT
        outputDir: 'D:\AutoReel\out'       # 默认 %LOCALAPPDATA%\AutoReel\out
        scanFps: 2
        chunkSize: 60
        engine: auto                       # auto | js | ps；auto 优先 js，早期失败回落 ps
        sourcePath: ''                     # 空 = 回放目录里最新一条
        pre: 3.5                           # 击杀前秒数（0-10），侧栏面板可改
        post: 1.5                          # 击杀后秒数（0-10），侧栏面板可改
        # 速度开关（默认档的成片与旧版逐字节一致，只在不追求这一点时才换档）
        encoder: libx264                   # libx264 | nvenc（快约 10%，同画质体积 1.7×）| auto
        fastCopy: false                    # true = 切片 -c copy 无损直剪（9s → 0.6s，体积约 2×）
        extract: full                      # full | keyframe（GOP≤0.5s 时抽帧快 7×，取样帧差 ±1 帧）
'@
$readme = $readme.Replace('__MODELS_NOTE__', $modelsNote)
Write-Utf8 (Join-Path $pkg 'README.md') $readme

Write-Host "[5/5] 打包 ..."
$tarball = Join-Path $dist ("auto-reel-{0}.tgz" -f $version)
if (Test-Path -LiteralPath $tarball) { Remove-Item -LiteralPath $tarball -Force }
tar -czf $tarball -C $stage package
if ($LASTEXITCODE -ne 0) { throw 'tar 打包失败' }

$sizeMb = [math]::Round((Get-Item -LiteralPath $tarball).Length / 1MB, 1)
$entries = @(tar -tzf $tarball)
Write-Host ''
Write-Host ("产物: {0}  ({1} MB, {2} 个条目)" -f $tarball, $sizeMb, $entries.Count)
Write-Host '顶层内容:'
$entries | ForEach-Object { ($_ -split '/')[0..1] -join '/' } | Sort-Object -Unique | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
