/**
 * AutoReel 的 Client 半：`auto_reel` 工具卡片。
 *
 * 卡片只做展示：进度、击杀明细、成片播放、打开目录。数据来自 Host 的
 * /autoreel 路由（自定义 @Remote 需要 typert 代码生成，bundle 用不了）。
 *
 * 两种数据来源：
 * 1. 工具结果里的 job id → /api/runs/<id>（会话内、插件没重启过）；
 * 2. 插件重启后 job 记录丢了 → 退回工具结果里的 output 路径自己拼媒体地址，
 *    至少还能播放、能打开目录（击杀明细只留结果文本里的统计行）。
 *
 * 版式约束：这张卡长在折叠的「已调用工具」区域里，可视高度有限，
 * 所以视频压到 220px、击杀走两列、按钮放标题行——整卡目标 360px 以内。
 */
window.__ModuleLoader__.load({
  id: '@local/auto-reel',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React
    const API = '/autoreel/api'
    const MEDIA = '/autoreel/media'
    const MAX_KILLS = 8
    // 受害者栏为空时的占位（BUGS #1：别让空字符串渲染成空白栏，看着像界面坏了）
    const VICTIM_PLACEHOLDER = '（未识别受害者）'

    function basename (p) {
      if (typeof p !== 'string' || !p) return ''
      const parts = p.split(/[\\/]/)
      return parts[parts.length - 1] || ''
    }

    function stemOf (p) {
      return basename(p).replace(/\.(mp4|m4v|mov|mkv)$/i, '').replace(/^Valorant\s+/, '').replace(/\.DVR$/i, '')
    }

    /** out/<素材名>/highlight_reel.mp4 → <素材名> */
    function stemFromOutPath (p) {
      if (typeof p !== 'string' || !p) return ''
      const parts = p.split(/[\\/]/)
      return parts.length >= 2 ? parts[parts.length - 2] : ''
    }

    /** out/<素材名>/highlight_reel.mp4 → out/<素材名> */
    function dirnameOf (p) {
      if (typeof p !== 'string' || !p) return ''
      const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
      return cut > 0 ? p.slice(0, cut) : ''
    }

    /**
     * 用 DSH 自己的 open-in-app 路由打开目录（页面内 fetch 自带鉴权）。
     * 宿主没挂这套路由时返回 false，调用方再走插件兜底。
     */
    async function openInFileManager (dir) {
      if (!dir) return false
      try {
        const appsResponse = await fetch('/open-in-app/apps', { headers: { accept: 'application/json' } })
        if (!appsResponse.ok) return false
        const payload = await appsResponse.json().catch(() => null)
        const apps = payload && Array.isArray(payload.apps) ? payload.apps : []
        if (apps.length === 0) return false
        const app = ['explorer', 'finder', 'filemanager'].find((id) => apps.includes(id)) || apps[0]
        const openResponse = await fetch('/open-in-app/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app, path: dir })
        })
        return openResponse.ok
      } catch {
        return false
      }
    }

    function textOf (block) {
      if (!block || !Array.isArray(block.content)) return ''
      const parts = []
      for (const item of block.content) {
        if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
        else if (item) parts.push(JSON.stringify(item))
      }
      return parts.join('\n')
    }

    function field (text, key) {
      const match = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(text || '')
      return match ? match[1].trim() : null
    }

    function argsSource (block) {
      if (!block || typeof block !== 'object') return null
      const raw = ('kind' in block) ? (block.call && block.call.argsRaw) || '' : (block.argsRaw || '')
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed.source === 'string' ? parsed.source : null
      } catch {
        return null
      }
    }

    function clampPct (value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return 0
      return Math.max(0, Math.min(100, n))
    }

    const styles = {
      card: {
        marginTop: 6,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.5,
        maxWidth: '100%',
        boxSizing: 'border-box'
      },
      head: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
      title: { fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      stem: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' },
      pill: {
        flex: '0 0 auto',
        fontSize: 11,
        padding: '0 8px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)'
      },
      pillOk: { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-state-success-primary)' },
      pillError: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
      button: {
        flex: '0 0 auto',
        fontSize: 11,
        padding: '1px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer'
      },
      track: { height: 4, borderRadius: 2, background: 'var(--dsw-alias-border-l2)', overflow: 'hidden', margin: '6px 0 4px' },
      fill: { height: '100%', borderRadius: 2, background: 'var(--dsw-alias-brand-primary)', transition: 'width .3s ease' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      video: {
        // 成片是 2560x1440（16:9）。只限高度会让播放器被拉成全行宽、左右各留一大块黑边，
        // 所以按 16:9 限宽：480 x 270，画面撑满、卡片也不会长过「已调用工具」的可视区。
        width: '100%',
        maxWidth: 480,
        aspectRatio: '16 / 9',
        height: 'auto',
        borderRadius: 8,
        background: '#000',
        display: 'block',
        margin: '6px 0 2px'
      },
      kills: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        columnGap: 18,
        margin: '6px 0 0',
        padding: 0,
        listStyle: 'none',
        fontSize: 12
      },
      killRow: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0, padding: '1px 0' },
      killTime: {
        flex: '0 0 auto',
        width: 46,
        textAlign: 'right',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums'
      },
      killText: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      revealError: { flex: '0 0 auto', fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' }
    }

    const STATUS_LABEL = { running: '剪辑中', completed: '完成', failed: '失败', killed: '已取消' }

    function HighlightCard (props) {
      const block = props && props.block
      const done = Boolean(block && typeof block === 'object' && 'kind' in block)
      const preparing = Boolean(block && typeof block === 'object' && block.phase === 'preparing')
      const resultText = useMemo(() => (done ? textOf(block) : ''), [done, block])
      const jobId = useMemo(() => field(resultText, 'job'), [resultText])
      const outPath = useMemo(() => field(resultText, 'output'), [resultText])
      const statsLine = useMemo(() => field(resultText, 'kills'), [resultText])
      const textLocalId = useMemo(() => field(resultText, 'localId'), [resultText])
      const askedSource = useMemo(() => argsSource(block), [block])

      const [run, setRun] = useState(null)
      const [missing, setMissing] = useState(false)
      const [fetchError, setFetchError] = useState(null)
      const [revealState, setRevealState] = useState(null)

      // 工具超时返回时 block 已完成但任务还在跑：有 job id 就以 run 状态为准，别急着显示完成
      const status = run && run.status ? run.status : (jobId ? 'running' : (done ? 'completed' : 'running'))
      const failed = status === 'failed' || status === 'killed' || (done && block && block.isError === true)
      const completed = status === 'completed'
      const shouldPoll = !missing && (jobId
        ? (!done || !run || run.status === 'running')
        : (!done || (run && run.status === 'running')))

      useEffect(() => {
        if (!shouldPoll) return undefined
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const url = jobId ? `${API}/runs/${encodeURIComponent(jobId)}` : `${API}/runs/latest`
            const response = await fetch(url, { headers: { accept: 'application/json' } })
            const data = await response.json().catch(() => null)
            if (!alive) return
            if (response.status === 404 && jobId) {
              // 插件重启过，作业记录没了：别继续打接口，走 output 路径兜底
              setMissing(true)
            } else if (!response.ok) {
              setFetchError(`接口返回 ${response.status}`)
            } else if (data && data.id) {
              const sameJob = jobId ? data.id === jobId : true
              const sameSource = !jobId || !askedSource ? true : !data.source || basename(data.source) === basename(askedSource)
              if (sameJob && sameSource) {
                setRun(data)
                setFetchError(null)
              }
            }
          } catch (error) {
            if (alive) setFetchError(String((error && error.message) || error))
          }
          if (alive) timer = setTimeout(tick, 1500)
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [jobId, askedSource, shouldPoll])

      const pct = clampPct(run && run.pct !== undefined ? run.pct : (completed ? 100 : 0))
      const kills = (run && Array.isArray(run.kills)) ? run.kills : []
      const localId = (run && run.localId) || textLocalId || ''
      const stem = (run && run.stem) || stemFromOutPath(outPath) || stemOf(askedSource || '')
      const mediaUrl = (run && run.mediaUrl) || (stem ? `${MEDIA}/${encodeURIComponent(stem)}/highlight_reel.mp4` : null)

      const reveal = useCallback(async () => {
        try {
          setRevealState({ ok: true, text: '正在打开…' })
          const failures = []
          let target = (run && run.output) || outPath

          // 有些卡片来自"作业还在跑"时返回的结果文本（没有 output 行），插件重启后作业记录也丢了。
          // 视频能播就说明文件在，用 /api/library 按素材名把绝对路径反查回来。
          if (!target && stem) {
            try {
              const listing = await fetch(`${API}/library`)
              if (listing.ok) {
                const payload = await listing.json()
                const items = payload && Array.isArray(payload.items) ? payload.items : []
                const hit = items.find((item) => item && item.stem === stem)
                if (hit && hit.path) target = hit.path
              }
            } catch {
              // 查不到就交给下面的兜底
            }
          }

          // 主路径：DSH 自己的 open-in-app 路由，用系统文件管理器打开成片所在目录。
          // 页面内 fetch 会带上浏览器鉴权（curl 打同一地址是 401）。
          if (target) {
            try {
              const dir = dirnameOf(target)
              const appsResponse = await fetch('/open-in-app/apps', { headers: { accept: 'application/json' } })
              if (appsResponse.ok) {
                const payload = await appsResponse.json().catch(() => null)
                const apps = payload && Array.isArray(payload.apps) ? payload.apps : []
                if (apps.length > 0) {
                  const preferred = ['explorer', 'finder', 'filemanager'].find((id) => apps.includes(id)) || apps[0]
                  const openResponse = await fetch('/open-in-app/open', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ app: preferred, path: dir })
                  })
                  if (openResponse.ok) {
                    setRevealState({ ok: true, text: '已用文件管理器打开目录' })
                    return
                  }
                  failures.push(`open-in-app ${openResponse.status}`)
                } else {
                  failures.push('宿主没有可用的文件管理器')
                }
              } else {
                failures.push(`apps 路由 ${appsResponse.status}`)
              }
            } catch (error) {
              failures.push(`open-in-app 报错：${(error && error.message) || error}`)
            }
          }

          // 兜底：插件自己的路由（只需要素材名，自己拉起系统文件管理器）
          if (!stem) {
            setRevealState({ ok: false, text: `没有成片路径${failures.length > 0 ? `（${failures.join('；')}）` : ''}` })
            return
          }
          const response = await fetch(`${API}/reveal`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stem, id: run && run.id ? run.id : '' })
          })
          const data = await response.json().catch(() => null)
          if (response.ok && data && data.ok !== false) {
            setRevealState({ ok: true, text: '已打开目录（插件兜底）' })
          } else {
            const detail = failures.length > 0 ? `；${failures.join('；')}` : ''
            setRevealState({ ok: false, text: `打开失败：${(data && data.error) || `HTTP ${response.status}`}${detail}` })
          }
        } catch (error) {
          setRevealState({ ok: false, text: `打开失败：${(error && error.message) || error}` })
        }
      }, [stem, outPath, run])

      // 提示两秒后自己消失，别把卡片永久撑高
      useEffect(() => {
        if (!revealState) return undefined
        const timer = setTimeout(() => setRevealState(null), 2500)
        return () => clearTimeout(timer)
      }, [revealState])

      // 文本是「本机 ID + 受害者」连写，切掉本机 ID 就是受害者。两种空值都要给占位符，
      // 否则那一栏渲染成空白，看起来像界面坏了（BUGS #1 的连带修复）：
      //   ① 整条为空（没有文本）；② 只剩本机 ID —— 理论上引擎已经不会把这种行当击杀了。
      const victimOf = (text) => {
        if (typeof text !== 'string' || text.length === 0) return VICTIM_PLACEHOLDER
        if (localId && text.startsWith(localId)) return text.slice(localId.length) || VICTIM_PLACEHOLDER
        return text
      }

      const revealButton = mediaUrl
        ? h('button', { type: 'button', style: styles.button, onClick: reveal, title: outPath || '' }, '打开目录')
        : null

      const head = h('div', { style: styles.head },
        h('span', { style: styles.title }, '击杀集锦', stem ? h('span', { style: styles.stem }, ` · ${stem}`) : null),
        revealButton,
        revealState && h('span', { style: revealState.ok ? styles.muted : styles.revealError }, revealState.text),
        h('span', { style: failed ? { ...styles.pill, ...styles.pillError } : (completed ? { ...styles.pill, ...styles.pillOk } : styles.pill) },
          preparing ? '准备中' : (STATUS_LABEL[status] || status))
      )

      if (preparing || (!run && !completed && !failed)) {
        return h('div', { style: styles.card }, head, h('div', { style: styles.muted }, '正在剪辑…进度马上就来'))
      }

      const progressText = run && run.progress ? run.progress : (completed ? '完成' : '剪辑中')
      const summary = completed
        ? (run
            ? [
                run.media && run.media.width ? `${run.media.width}×${run.media.height}` : null,
                `${kills.length} 次击杀`,
                run.segments ? `${run.segments.length} 段` : null,
                run.duration ? `${run.duration}s` : null,
                run.sizeMb ? `${run.sizeMb} MB` : null,
                localId ? `本机 ID ${localId}` : null
              ].filter(Boolean).join(' · ')
            : (statsLine ? statsLine.replace(/\s{2,}/g, ' · ') : null))
        : null

      const shownKills = kills.slice(0, MAX_KILLS)

      return h('div', { style: styles.card },
        head,
        !completed && !failed && h('div', null,
          h('div', { style: styles.track }, h('div', { style: { ...styles.fill, width: `${pct}%` } })),
          h('div', { style: styles.muted }, `${Math.round(pct)}% · ${progressText}`)
        ),
        summary && h('div', { style: styles.muted }, summary),
        completed && mediaUrl && h('video', {
          key: mediaUrl,
          style: {
            ...styles.video,
            // 21:9 / 16:10 的源别被 16:9 框住
            aspectRatio: run && run.media && run.media.width && run.media.height
              ? `${run.media.width} / ${run.media.height}`
              : '16 / 9'
          },
          src: mediaUrl,
          controls: true,
          preload: 'metadata',
          playsInline: true
        }),
        shownKills.length > 0 && h('ul', { style: styles.kills },
          shownKills.map((kill, index) => h('li', { key: `${kill.t}-${index}`, style: styles.killRow },
            h('span', { style: styles.killTime }, `${Number(kill.t).toFixed(1)}s`),
            h('span', { style: styles.killText }, victimOf(kill.text))
          )),
          kills.length > MAX_KILLS ? h('li', { key: 'more', style: { ...styles.muted, gridColumn: '1 / -1' } }, `… 另有 ${kills.length - MAX_KILLS} 条`) : null
        ),
        failed && run && run.error && h('div', { style: styles.error }, run.error),
        fetchError && !failed && !mediaUrl && h('div', { style: styles.muted }, `界面取进度失败：${fetchError}`)
      )
    }

    // ── 右侧栏面板：设置 + 直接剪 ────────────────────────────────
    const NS = 'autoReel'
    const PANEL_ID = '@local/auto-reel/panel'
    const PANEL_KIND = 'auto-reel'
    const THEME_KEY = 'autoreel.panel.theme'
    const PRESETS = [
      { id: 'compact', pre: 2, post: 1 },
      { id: 'standard', pre: 3.5, post: 1.5 },
      { id: 'cinematic', pre: 5, post: 2 }
    ]
    const DICT = {
      zh: {
        'tab.title': 'AutoReel',
        'guide.title': 'AutoReel 设置',
        'guide.description': '选回放、输出目录与击杀前后秒数，直接出片',
        'brand.badge': 'VALORANT DVR',
        'brand.subtitle': '高光击杀自动识别与无损剪辑',
        'theme.toggle': '切换深色 / 浅色主题',
        'status.synced': '配置已同步',
        'status.dirty': '有未保存的更改',
        'status.saving': '保存中…',
        'status.saved': '已保存',
        'state.loading': '读取设置…',
        'state.retry': '重试',
        'error.settingsHint': '没有读到本机设置。为避免覆盖，表单已锁住；修好后点重试。',
        'io.title': '输入与输出',
        'io.tag': 'LOCAL I/O',
        'io.replaysDir': '回放目录',
        'io.source': '回放文件',
        'io.sourceHint': '已按修改时间倒序排列',
        'io.outputDir': '输出目录',
        'io.latest': '最新一条（自动）',
        'io.latestDesc': '按修改时间自动选最新一条',
        'io.latestChip': 'AUTO',
        'io.browse': '浏览...',
        'io.refresh': '重新扫描回放目录',
        'io.busy': '扫描中…',
        'io.empty': '这个目录里没有录像',
        'io.needDir': '先填写回放目录',
        'io.stray': '（不在当前目录）',
        'io.files': '条',
        'clip.title': '剪辑参数',
        'clip.presets': '快捷剪辑预设',
        'preset.compact': '紧凑连杀',
        'preset.standard': '标准高光',
        'preset.cinematic': '完整铺垫',
        'clip.merge': '合并阈值',
        'clip.mergeHintA': '两次击杀间隔 ≤',
        'clip.mergeHintB': '时将自动合并为连杀片段',
        'clip.killMoment': '击杀瞬间',
        'clip.pre': '击杀前（秒）',
        'clip.post': '击杀后（秒）',
        'clip.range': '0.5s - 10.0s',
        'clip.inPoint': '入点（击杀前）',
        'clip.outPoint': '出点（击杀后）',
        'clip.total': '单次高光总时长',
        'action.cut': '剪这条回放',
        'action.cutting': '正在剪辑…',
        'action.save': '保存设置',
        'action.cancel': '取消',
        'action.open': '打开目录',
        'action.collapse': '完成并收起',
        'action.dismiss': '收起结果',
        'progress.working': '正在分析击杀画面…',
        'progress.label': '剪辑进度',
        'progress.waiting': '准备中…',
        'progress.done': '剪辑完成',
        'progress.doneText': '已生成 {n} 段高光，已保存至输出目录',
        'progress.canceled': '任务已取消',
        'progress.canceling': '正在取消…',
        'progress.failed': '剪辑失败',
        'state.opened': '已打开目录',
        'footer.hint': '保存后，聊天里调用 auto_reel 也会用这些值，立即生效。',
        'error.pre': '击杀前秒数需要 0.5–10',
        'error.post': '击杀后秒数需要 0.5–10',
        'error.staleSource': '当前选择的回放不在这个目录里，请重新选择',
        'error.settings': '读取设置失败',
        'error.noReel': '还没有成片',
        'error.lost': '任务记录已丢失（插件可能重启过）',
        'unit.kills': '次击杀',
        'unit.segments': '段',
        'unit.kill': '击杀',
        'unit.seg': '段',
        'unit.more': '另有 {n} 条'
      },
      en: {
        'tab.title': 'AutoReel',
        'guide.title': 'AutoReel settings',
        'guide.description': 'Pick a replay, output folder and the seconds around each kill, then cut',
        'brand.badge': 'VALORANT DVR',
        'brand.subtitle': 'Automatic kill detection and lossless clipping',
        'theme.toggle': 'Switch dark / light theme',
        'status.synced': 'Settings synced',
        'status.dirty': 'Unsaved changes',
        'status.saving': 'Saving…',
        'status.saved': 'Saved',
        'state.loading': 'Loading settings…',
        'state.retry': 'Retry',
        'error.settingsHint': 'Settings could not be read. The form is locked so it cannot overwrite them — fix the problem, then retry.',
        'io.title': 'Input & output',
        'io.tag': 'LOCAL I/O',
        'io.replaysDir': 'Replays folder',
        'io.source': 'Replay file',
        'io.sourceHint': 'Newest first',
        'io.outputDir': 'Output folder',
        'io.latest': 'Latest (auto)',
        'io.latestDesc': 'Picks the newest replay by modified time',
        'io.latestChip': 'AUTO',
        'io.browse': 'Browse...',
        'io.refresh': 'Rescan replay folder',
        'io.busy': 'Scanning…',
        'io.empty': 'No replays in this folder',
        'io.needDir': 'Enter a replays folder first',
        'io.stray': ' (not in this folder)',
        'io.files': 'files',
        'clip.title': 'Clipping',
        'clip.presets': 'Quick presets',
        'preset.compact': 'Tight multi-kill',
        'preset.standard': 'Standard highlight',
        'preset.cinematic': 'Full buildup',
        'clip.merge': 'Merge window',
        'clip.mergeHintA': 'Kills ≤',
        'clip.mergeHintB': 'apart merge into one multi-kill clip',
        'clip.killMoment': 'Kill moment',
        'clip.pre': 'Seconds before',
        'clip.post': 'Seconds after',
        'clip.range': '0.5s - 10.0s',
        'clip.inPoint': 'In point (before)',
        'clip.outPoint': 'Out point (after)',
        'clip.total': 'Clip length',
        'action.cut': 'Cut this replay',
        'action.cutting': 'Cutting…',
        'action.save': 'Save settings',
        'action.cancel': 'Cancel',
        'action.open': 'Open folder',
        'action.collapse': 'Done',
        'action.dismiss': 'Dismiss',
        'progress.working': 'Scanning the killfeed…',
        'progress.label': 'Clipping progress',
        'progress.waiting': 'Starting…',
        'progress.done': 'Clip ready',
        'progress.doneText': 'Generated {n} highlight clip(s), saved to the output folder',
        'progress.canceled': 'Run canceled',
        'progress.canceling': 'Canceling…',
        'progress.failed': 'Clip failed',
        'state.opened': 'Folder opened',
        'footer.hint': 'Saved values are also used by auto_reel from chat, and apply immediately.',
        'error.pre': 'Seconds before must be 0.5–10',
        'error.post': 'Seconds after must be 0.5–10',
        'error.staleSource': 'The selected replay is not in this folder — pick one again',
        'error.settings': 'Could not load settings',
        'error.noReel': 'No reel yet',
        'error.lost': 'Run record is gone (plugin may have restarted)',
        'unit.kills': 'kills',
        'unit.segments': 'segments',
        'unit.kill': 'kill',
        'unit.seg': 'clip',
        'unit.more': '{n} more'
      }
    }

    const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace"

    /**
     * 面板样式。宿主页面只有 CSS 变量可用，没有 Tailwind 运行时，所以这里
     * 自带一份作用域在 .ar- 前缀下的样式表；浅色是默认主题，深色靠 data-theme 覆盖。
     */
    const PANEL_CSS = `
@keyframes ar-spin { to { transform: rotate(360deg); } }
@keyframes ar-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

.ar-root {
  --ar-bg: #f8fafc;
  --ar-card: #ffffff;
  --ar-field: #f8fafc;
  --ar-ink: #0f172a;
  --ar-ink-2: #334155;
  --ar-muted: #475569;
  --ar-faint: #64748b;
  --ar-line: #e2e8f0;
  --ar-line-2: #cbd5e1;
  --ar-soft: #f1f5f9;
  --ar-hover: #eef2f7;
  --ar-coral: #ff4655;
  --ar-coral-ink: #dc2634;
  --ar-coral-soft: rgba(255, 70, 85, 0.1);
  --ar-coral-line: rgba(255, 70, 85, 0.28);
  --ar-sky: #0ea5e9;
  --ar-sky-ink: #0369a1;
  --ar-sky-soft: rgba(56, 189, 248, 0.16);
  --ar-ok: #047857;
  --ar-ok-soft: rgba(5, 150, 105, 0.1);
  --ar-warn: #b45309;
  --ar-warn-soft: rgba(217, 119, 6, 0.1);
  --ar-err: #dc2626;
  --ar-err-soft: rgba(220, 38, 38, 0.08);
  --ar-grid: rgba(15, 23, 42, 0.035);
  --ar-glow: rgba(255, 70, 85, 0.1);
  --ar-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 18px 36px -26px rgba(15, 23, 42, 0.32);
  --ar-menu-shadow: 0 18px 44px -18px rgba(15, 23, 42, 0.35), 0 0 0 1px rgba(15, 23, 42, 0.05);
  height: 100%;
  box-sizing: border-box;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 14px 12px 22px;
  color: var(--ar-ink);
  font-family: Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  background-color: var(--ar-bg);
  background-image:
    radial-gradient(120% 55% at 50% -12%, var(--ar-glow), transparent 62%),
    linear-gradient(to right, var(--ar-grid) 1px, transparent 1px),
    linear-gradient(to bottom, var(--ar-grid) 1px, transparent 1px);
  background-size: 100% 100%, 32px 32px, 32px 32px;
  transition: background-color 0.2s ease, color 0.2s ease;
  scrollbar-width: thin;
  scrollbar-color: var(--ar-line-2) transparent;
}
.ar-root[data-theme="dark"] {
  --ar-bg: #0b0e14;
  --ar-card: #131722;
  --ar-field: #0d1117;
  --ar-ink: #f1f5f9;
  --ar-ink-2: #cbd5e1;
  --ar-muted: #a5b3c6;
  --ar-faint: #8fa0b5;
  --ar-line: rgba(255, 255, 255, 0.08);
  --ar-line-2: rgba(255, 255, 255, 0.16);
  --ar-soft: rgba(255, 255, 255, 0.045);
  --ar-hover: rgba(255, 255, 255, 0.07);
  --ar-coral-soft: rgba(255, 70, 85, 0.15);
  --ar-coral-line: rgba(255, 70, 85, 0.38);
  --ar-coral-ink: #ff7884;
  --ar-sky: #38bdf8;
  --ar-sky-ink: #7dd3fc;
  --ar-sky-soft: rgba(56, 189, 248, 0.16);
  --ar-ok: #34d399;
  --ar-ok-soft: rgba(52, 211, 153, 0.12);
  --ar-warn: #fbbf24;
  --ar-warn-soft: rgba(251, 191, 36, 0.12);
  --ar-err: #f87171;
  --ar-err-soft: rgba(248, 113, 113, 0.12);
  --ar-grid: rgba(255, 255, 255, 0.022);
  --ar-glow: rgba(255, 70, 85, 0.16);
  --ar-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 22px 44px -30px rgba(0, 0, 0, 0.9);
  --ar-menu-shadow: 0 24px 56px -18px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.04);
  color-scheme: dark;
}
.ar-root *, .ar-root *::before, .ar-root *::after { box-sizing: border-box; }
.ar-root ::selection { background: var(--ar-coral-soft); color: var(--ar-coral-ink); }
.ar-shell { width: 100%; max-width: 700px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; container-type: inline-size; }

.ar-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ar-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ar-mark { position: relative; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 11px; color: #fff; background: linear-gradient(135deg, #ff4655, #d92d3c); box-shadow: 0 9px 20px -9px rgba(255, 70, 85, 0.7), inset 0 0 0 1px rgba(255, 255, 255, 0.18); }
.ar-mark-dot { position: absolute; right: -3px; bottom: -3px; display: flex; align-items: center; justify-content: center; width: 13px; height: 13px; border-radius: 999px; background: var(--ar-bg); }
.ar-mark-dot i { display: block; width: 7px; height: 7px; border-radius: 999px; background: #34d399; }
.ar-brand-text { min-width: 0; }
.ar-brand-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.ar-title { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.15; color: var(--ar-ink); }
.ar-badge { padding: 2px 6px; border-radius: 5px; border: 1px solid var(--ar-coral-line); background: var(--ar-coral-soft); color: var(--ar-coral-ink); font-family: ${MONO}; font-size: 9px; font-weight: 600; letter-spacing: 0.1em; line-height: 1.4; text-transform: uppercase; white-space: nowrap; }
.ar-subtitle { margin: 3px 0 0; overflow: hidden; color: var(--ar-muted); font-size: 11px; line-height: 1.35; white-space: nowrap; text-overflow: ellipsis; }
.ar-head-actions { display: flex; align-items: center; gap: 7px; margin-left: auto; }
.ar-pill { display: inline-flex; align-items: center; gap: 6px; max-width: 190px; padding: 5px 9px; overflow: hidden; border: 1px solid var(--ar-line); border-radius: 999px; background: var(--ar-card); color: var(--ar-muted); font-size: 10.5px; font-weight: 500; white-space: nowrap; transition: color 0.2s ease, background-color 0.2s ease, border-color 0.2s ease; }
.ar-pill > span { overflow: hidden; text-overflow: ellipsis; }
.ar-pill .ar-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 999px; background: var(--ar-faint); }
.ar-pill.is-ok { border-color: rgba(5, 150, 105, 0.22); background: var(--ar-ok-soft); color: var(--ar-ok); }
.ar-pill.is-ok .ar-dot { background: var(--ar-ok); }
.ar-pill.is-warn { border-color: rgba(217, 119, 6, 0.26); background: var(--ar-warn-soft); color: var(--ar-warn); }
.ar-pill.is-warn .ar-dot { background: var(--ar-warn); animation: ar-pulse 1.6s ease-in-out infinite; }
.ar-pill.is-busy { border-color: var(--ar-coral-line); background: var(--ar-coral-soft); color: var(--ar-coral-ink); }
.ar-pill.is-busy .ar-dot { background: var(--ar-coral); animation: ar-pulse 1.1s ease-in-out infinite; }
.ar-pill.is-err { border-color: rgba(220, 38, 38, 0.24); background: var(--ar-err-soft); color: var(--ar-err); }
.ar-pill.is-err .ar-dot { background: var(--ar-err); }
@keyframes ar-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.ar-icon-btn { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 30px; height: 30px; border: 1px solid var(--ar-line); border-radius: 9px; background: var(--ar-card); color: var(--ar-muted); cursor: pointer; transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease; }
.ar-icon-btn:hover { border-color: var(--ar-line-2); background: var(--ar-hover); color: var(--ar-ink); }
.ar-icon-btn:active { transform: scale(0.95); }
.ar-icon-btn:disabled { opacity: 0.45; cursor: default; }
.ar-icon-btn.is-square { width: 38px; height: 38px; border-radius: 10px; }
.ar-spin { animation: ar-spin 0.9s linear infinite; }

.ar-card { padding: 13px; border: 1px solid var(--ar-line); border-radius: 15px; background: var(--ar-card); box-shadow: var(--ar-shadow); transition: background-color 0.2s ease, border-color 0.2s ease; }
.ar-card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 7px 10px; margin-bottom: 12px; }
.ar-card-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ar-card-title svg { color: var(--ar-coral); }
.ar-card-title h2 { margin: 0; color: var(--ar-ink-2); font-size: 13px; font-weight: 600; letter-spacing: 0.01em; }
.ar-tag { color: var(--ar-faint); font-family: ${MONO}; font-size: 10px; font-weight: 500; letter-spacing: 0.09em; white-space: nowrap; }
.ar-presets { display: flex; flex: 1 1 170px; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; }
.ar-preset { display: inline-flex; align-items: baseline; gap: 4px; padding: 3px 7px; border: 1px solid var(--ar-line); border-radius: 7px; background: var(--ar-field); color: var(--ar-muted); font-family: inherit; font-size: 10px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease; }
.ar-preset:hover { border-color: var(--ar-line-2); background: var(--ar-hover); color: var(--ar-ink-2); }
.ar-preset.is-active { border-color: var(--ar-coral-line); background: var(--ar-coral-soft); color: var(--ar-coral-ink); }
.ar-preset-num { font-family: ${MONO}; font-size: 9px; font-variant-numeric: tabular-nums; opacity: 0.72; }
.ar-card-body { display: flex; flex-direction: column; gap: 12px; }
.ar-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ar-label { display: block; color: var(--ar-muted); font-size: 12px; font-weight: 500; }
.ar-label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ar-sublabel { color: var(--ar-faint); font-size: 10.5px; white-space: nowrap; }

.ar-inputgroup { display: flex; align-items: stretch; height: 38px; overflow: hidden; border: 1px solid var(--ar-line); border-radius: 10px; background: var(--ar-field); transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.ar-inputgroup:focus-within { border-color: var(--ar-coral); box-shadow: 0 0 0 3px var(--ar-coral-soft); }
.ar-leading { display: flex; flex: 0 0 auto; align-items: center; padding: 0 7px 0 10px; color: var(--ar-faint); }
.ar-input { flex: 1 1 auto; width: 100%; min-width: 0; padding: 0 6px; border: 0; outline: 0; background: transparent; color: var(--ar-ink-2); font-family: ${MONO}; font-size: 11.5px; text-overflow: ellipsis; }
.ar-input::placeholder { color: var(--ar-faint); }
.ar-browse { flex: 0 0 auto; padding: 0 10px; border: 0; border-left: 1px solid var(--ar-line); background: var(--ar-soft); color: var(--ar-ink-2); font-family: inherit; font-size: 10.5px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: background-color 0.15s ease; }
.ar-browse:hover { background: var(--ar-hover); }
.ar-browse:disabled { opacity: 0.5; cursor: default; }

.ar-source-row { display: flex; align-items: stretch; gap: 7px; }
.ar-select-wrap { position: relative; flex: 1 1 auto; min-width: 0; }
.ar-select { display: flex; align-items: center; gap: 7px; width: 100%; height: 38px; padding: 0 9px 0 10px; border: 1px solid var(--ar-line); border-radius: 10px; background: var(--ar-field); color: var(--ar-ink-2); font-family: inherit; text-align: left; cursor: pointer; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.ar-select:hover { border-color: var(--ar-line-2); }
.ar-select[aria-expanded="true"] { border-color: var(--ar-coral); box-shadow: 0 0 0 3px var(--ar-coral-soft); }
.ar-select > svg { flex: 0 0 auto; color: var(--ar-coral); }
.ar-file-name { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--ar-ink); font-family: ${MONO}; font-size: 11.5px; font-weight: 500; white-space: nowrap; text-overflow: ellipsis; }
.ar-file-name.is-ghost { color: var(--ar-muted); font-weight: 400; }
.ar-size { flex: 0 0 auto; padding: 1px 5px; border-radius: 5px; background: var(--ar-soft); color: var(--ar-muted); font-family: ${MONO}; font-size: 9.5px; white-space: nowrap; }
.ar-size.is-ghost { color: var(--ar-faint); letter-spacing: 0.06em; }
.ar-chevron { flex: 0 0 auto; color: var(--ar-faint); transition: transform 0.18s ease; }
.ar-chevron.is-open { transform: rotate(180deg); }
.ar-menu { position: absolute; top: calc(100% + 6px); right: 0; left: 0; z-index: 40; max-height: 264px; overflow-y: auto; padding: 4px; border: 1px solid var(--ar-line); border-radius: 12px; background: var(--ar-card); box-shadow: var(--ar-menu-shadow); animation: ar-in 0.16s ease both; }
.ar-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--ar-ink-2); font-family: inherit; text-align: left; cursor: pointer; }
.ar-option:hover { background: var(--ar-hover); }
.ar-option.is-selected { background: var(--ar-coral-soft); color: var(--ar-coral-ink); }
.ar-option-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 1px; min-width: 0; }
.ar-option-name { overflow: hidden; font-family: ${MONO}; font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.ar-option-meta { overflow: hidden; color: var(--ar-faint); font-size: 9.5px; white-space: nowrap; text-overflow: ellipsis; }
.ar-option > svg { flex: 0 0 auto; color: var(--ar-faint); }
.ar-option.is-selected > svg { color: var(--ar-coral); }

.ar-alert { max-height: 140px; overflow-y: auto; padding: 7px 9px; border: 1px solid rgba(220, 38, 38, 0.24); border-radius: 8px; background: var(--ar-err-soft); color: var(--ar-err); font-size: 10.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.ar-hint { color: var(--ar-faint); font-size: 10.5px; line-height: 1.5; }

.ar-timeline { margin-bottom: 12px; padding: 11px; border: 1px solid var(--ar-line); border-radius: 12px; background: var(--ar-field); }
.ar-timeline.is-invalid .ar-bar, .ar-timeline.is-invalid .ar-pin { opacity: 0.45; }
.ar-timeline-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 7px; margin-bottom: 14px; }
.ar-mergebadge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border: 1px solid var(--ar-coral-line); border-radius: 6px; background: var(--ar-coral-soft); color: var(--ar-coral-ink); font-family: ${MONO}; font-size: 10px; font-weight: 600; white-space: nowrap; }
.ar-mergebadge b { font-weight: 700; }
.ar-mergehint { flex: 1 1 150px; margin: 0; color: var(--ar-muted); font-size: 10px; line-height: 1.5; text-align: right; }
.ar-mergehint b { color: var(--ar-ink-2); font-family: ${MONO}; font-weight: 600; }
.ar-track-wrap { position: relative; padding-top: 19px; }
.ar-pin { position: absolute; top: 0; display: flex; flex-direction: column; align-items: center; transform: translateX(-50%); pointer-events: none; transition: left 0.2s ease; }
.ar-pin-badge { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border-radius: 999px; background: var(--ar-ink); color: var(--ar-bg); font-size: 9px; font-weight: 600; white-space: nowrap; box-shadow: 0 2px 6px rgba(15, 23, 42, 0.18); }
.ar-pin-badge svg { color: var(--ar-coral); }
.ar-bar { display: flex; width: 100%; height: 34px; overflow: hidden; border: 1px solid var(--ar-line); border-radius: 8px; background: var(--ar-soft); }
.ar-bar-pre { display: flex; align-items: center; justify-content: center; min-width: 0; border-right: 2px solid var(--ar-card); background: linear-gradient(90deg, rgba(56, 189, 248, 0.18), rgba(56, 189, 248, 0.38)); transition: width 0.2s ease; }
.ar-bar-post { display: flex; align-items: center; justify-content: center; min-width: 0; background: linear-gradient(90deg, rgba(255, 70, 85, 0.42), rgba(255, 70, 85, 0.16)); transition: width 0.2s ease; }
.ar-bar-label { overflow: hidden; padding: 0 6px; font-family: ${MONO}; font-size: 10.5px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.ar-bar-pre .ar-bar-label { color: var(--ar-sky-ink); }
.ar-bar-post .ar-bar-label { color: var(--ar-coral-ink); }
.ar-legend { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 5px 10px; margin-top: 7px; color: var(--ar-faint); font-family: ${MONO}; font-size: 9.5px; }
.ar-legend > span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.ar-legend b { color: var(--ar-ink-2); font-weight: 600; }
.ar-dot-sky, .ar-dot-coral { display: inline-block; width: 6px; height: 6px; border-radius: 999px; }
.ar-dot-sky { background: var(--ar-sky); }
.ar-dot-coral { background: var(--ar-coral); }
.ar-legend-total { margin-left: auto; }

.ar-grid2 { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.ar-param { min-width: 0; padding: 10px; border: 1px solid var(--ar-line); border-radius: 12px; background: var(--ar-field); }
.ar-param-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ar-param-label { display: inline-flex; align-items: center; gap: 5px; color: var(--ar-ink-2); font-size: 11px; font-weight: 500; }
.ar-param-dot { display: inline-block; width: 6px; height: 6px; border-radius: 999px; }
.ar-param-dot.is-sky { background: var(--ar-sky); }
.ar-param-dot.is-coral { background: var(--ar-coral); }
.ar-param-range { color: var(--ar-faint); font-family: ${MONO}; font-size: 9.5px; white-space: nowrap; }
.ar-stepper { display: flex; align-items: center; gap: 6px; margin: 9px 0 10px; }
.ar-step { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 30px; height: 30px; border: 1px solid var(--ar-line); border-radius: 8px; background: var(--ar-card); color: var(--ar-muted); cursor: pointer; transition: color 0.15s ease, border-color 0.15s ease, transform 0.1s ease; }
.ar-step:hover { border-color: var(--ar-line-2); color: var(--ar-ink); }
.ar-step:active { transform: scale(0.94); }
.ar-num { position: relative; flex: 1 1 auto; min-width: 0; display: flex; align-items: center; border: 1px solid var(--ar-line); border-radius: 8px; background: var(--ar-card); transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.ar-num.is-pre:focus-within { border-color: var(--ar-sky); box-shadow: 0 0 0 3px var(--ar-sky-soft); }
.ar-num.is-post:focus-within { border-color: var(--ar-coral); box-shadow: 0 0 0 3px var(--ar-coral-soft); }
.ar-num input { width: 100%; height: 30px; padding: 0 16px 0 8px; border: 0; outline: 0; background: transparent; color: var(--ar-ink); font-family: ${MONO}; font-size: 12px; font-weight: 600; text-align: center; -moz-appearance: textfield; }
.ar-num input::-webkit-inner-spin-button, .ar-num input::-webkit-outer-spin-button { margin: 0; -webkit-appearance: none; }
.ar-num-unit { position: absolute; right: 7px; color: var(--ar-faint); font-family: ${MONO}; font-size: 9.5px; pointer-events: none; }
.ar-slider { width: 100%; height: 6px; margin: 0; border-radius: 999px; outline: none; cursor: pointer; -webkit-appearance: none; appearance: none; }
.ar-slider::-webkit-slider-thumb { width: 14px; height: 14px; border: 2px solid #fff; border-radius: 999px; background: var(--ar-sky); box-shadow: 0 1px 4px rgba(15, 23, 42, 0.3); cursor: pointer; -webkit-appearance: none; appearance: none; transition: transform 0.12s ease; }
.ar-slider.is-post::-webkit-slider-thumb { background: var(--ar-coral); }
.ar-slider:hover::-webkit-slider-thumb { transform: scale(1.12); }
.ar-slider::-moz-range-thumb { width: 12px; height: 12px; border: 2px solid #fff; border-radius: 999px; background: var(--ar-sky); cursor: pointer; }
.ar-slider.is-post::-moz-range-thumb { background: var(--ar-coral); }

.ar-cta { display: flex; flex-direction: column; gap: 8px; }
.ar-cta-row { display: flex; align-items: stretch; gap: 8px; }
.ar-cut { display: inline-flex; flex: 1 1 auto; align-items: center; justify-content: center; gap: 8px; min-height: 46px; padding: 0 16px; border: 0; border-radius: 12px; background: linear-gradient(135deg, #ff4655, #e63946); color: #fff; font-family: inherit; font-size: 13.5px; font-weight: 600; box-shadow: 0 12px 24px -12px rgba(255, 70, 85, 0.75); cursor: pointer; transition: filter 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease; }
.ar-cut:hover:not(:disabled) { filter: brightness(1.06); box-shadow: 0 14px 28px -12px rgba(255, 70, 85, 0.85); }
.ar-cut:active:not(:disabled) { transform: scale(0.99); }
.ar-cut:disabled { opacity: 0.65; cursor: default; }
.ar-save { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; gap: 6px; min-height: 46px; padding: 0 13px; border: 1px solid var(--ar-line); border-radius: 12px; background: var(--ar-card); color: var(--ar-ink-2); font-family: inherit; font-size: 11.5px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease; }
.ar-save:hover:not(:disabled) { border-color: var(--ar-line-2); background: var(--ar-hover); }
.ar-save:active:not(:disabled) { transform: scale(0.99); }
.ar-save.is-dirty { border-color: rgba(217, 119, 6, 0.35); color: var(--ar-warn); }
.ar-save:disabled { opacity: 0.6; cursor: default; }
.ar-unsaved { display: inline-block; width: 6px; height: 6px; border-radius: 999px; background: var(--ar-warn); }

.ar-progress { margin-top: 2px; padding: 12px; border: 1px solid var(--ar-line); border-radius: 13px; background: var(--ar-card); box-shadow: var(--ar-shadow); animation: ar-in 0.2s ease both; }
.ar-progress-head { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 10px; }
.ar-status-icon { display: flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 31px; height: 31px; border-radius: 9px; background: var(--ar-coral-soft); color: var(--ar-coral); }
.ar-status-icon.is-ok { background: var(--ar-ok-soft); color: var(--ar-ok); }
.ar-status-icon.is-bad { background: var(--ar-err-soft); color: var(--ar-err); }
.ar-progress-copy { flex: 1 1 auto; min-width: 0; }
.ar-progress-title { margin: 0; color: var(--ar-ink); font-size: 12.5px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.ar-progress-sub { margin: 2px 0 0; overflow: hidden; color: var(--ar-faint); font-family: ${MONO}; font-size: 9.5px; white-space: nowrap; text-overflow: ellipsis; }
.ar-progress-side { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
.ar-pct { color: var(--ar-coral-ink); font-family: ${MONO}; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ar-pct.is-ok { color: var(--ar-ok); }
.ar-pct.is-bad { color: var(--ar-err); }
.ar-cancel { padding: 2px 6px; min-height: 24px; border: 0; border-radius: 6px; background: transparent; color: var(--ar-muted); font-family: inherit; font-size: 10px; cursor: pointer; }
.ar-cancel:hover { background: var(--ar-hover); color: var(--ar-ink); }
.ar-cancel:disabled { opacity: 0.55; cursor: default; }
.ar-progress-track { width: 100%; height: 6px; overflow: hidden; border-radius: 999px; background: var(--ar-soft); }
.ar-progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #ff4655, #ff7a85); transition: width 0.3s ease; }
.ar-progress-fill.is-ok { background: var(--ar-ok); }
.ar-progress-fill.is-bad { background: var(--ar-err); }
.ar-progress-meta { margin-top: 5px; overflow: hidden; color: var(--ar-faint); font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }

.ar-result { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--ar-line); }
.ar-stats { margin-bottom: 8px; color: var(--ar-muted); font-family: ${MONO}; font-size: 10px; font-variant-numeric: tabular-nums; }
.ar-video { display: block; width: 100%; aspect-ratio: 16 / 9; margin: 0 0 8px; border: 1px solid var(--ar-line); border-radius: 10px; background: #000; }
.ar-kills { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px 16px; margin: 0 0 8px; padding: 0; list-style: none; }
.ar-kill { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 1px 0; font-size: 10.5px; }
.ar-kill-time { flex: 0 0 auto; width: 40px; color: var(--ar-faint); font-family: ${MONO}; text-align: right; font-variant-numeric: tabular-nums; }
.ar-kill-text { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--ar-ink-2); white-space: nowrap; text-overflow: ellipsis; }
.ar-kill-more { grid-column: 1 / -1; padding: 1px 0; color: var(--ar-faint); font-size: 10px; }
.ar-result-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ar-ghost { display: inline-flex; align-items: center; gap: 5px; min-height: 24px; padding: 4px 8px; border: 1px solid var(--ar-line); border-radius: 7px; background: var(--ar-card); color: var(--ar-ink-2); font-family: inherit; font-size: 10px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: background-color 0.15s ease, border-color 0.15s ease; }
.ar-ghost:hover { background: var(--ar-hover); border-color: var(--ar-line-2); }
.ar-note { font-size: 10px; }
.ar-note.is-ok { color: var(--ar-ok); }
.ar-note.is-bad { color: var(--ar-err); }

.ar-done-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--ar-line); }
.ar-done-text { display: inline-flex; align-items: center; gap: 5px; color: var(--ar-ok); font-size: 10.5px; }
.ar-done-text.is-bad { color: var(--ar-err); }
.ar-done-text svg { flex: 0 0 auto; }
.ar-done-actions { display: flex; align-items: center; gap: 7px; }

.ar-footer-note { display: flex; align-items: flex-start; gap: 6px; padding: 2px 4px 4px; color: var(--ar-faint); font-size: 10px; line-height: 1.55; }
.ar-footer-note > svg { flex: 0 0 auto; margin-top: 2px; }

.ar-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 30px 14px; color: var(--ar-muted); font-size: 11.5px; }
.ar-loaderror { display: flex; flex-direction: column; gap: 8px; }
.ar-loaderror-head { display: flex; align-items: center; gap: 6px; color: var(--ar-err); font-size: 12.5px; font-weight: 600; }
.ar-loaderror .ar-alert { margin-top: 0; }
.ar-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.ar-option:focus-visible { outline: 2px solid var(--ar-coral); outline-offset: -2px; }

.ar-root button:focus-visible, .ar-root input:focus-visible { outline: 2px solid var(--ar-coral); outline-offset: 2px; }
.ar-root input:focus-visible { outline: none; }
.ar-root .ar-slider:focus-visible { outline: 2px solid var(--ar-coral); outline-offset: 3px; }

@container (min-width: 406px) {
  .ar-card { padding: 15px; }
  .ar-grid2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .ar-kills { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
@container (max-width: 346px) {
  .ar-tag { display: none; }
  .ar-mergehint { flex-basis: 100%; text-align: left; }
  .ar-legend-total { flex-basis: 100%; order: 3; margin-left: 0; text-align: center; }
}
@container (max-width: 306px) {
  .ar-cta-row { flex-direction: column; }
  .ar-save { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .ar-root *, .ar-root *::before, .ar-root *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`

    const ICONS = {
      crosshair: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M22 12h-4M6 12H2M12 6V2M12 22v-4' }]],
      folder: [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
      'folder-output': [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }], ['path', { d: 'M12 17V9' }], ['path', { d: 'm8 13 4-4 4 4' }]],
      'folder-open': [['path', { d: 'm6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2' }]],
      film: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['path', { d: 'M7 3v18M17 3v18M3 7.5h4M3 12h4M3 16.5h4M17 7.5h4M17 12h4M17 16.5h4' }]],
      'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
      'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
      'refresh-cw': [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }], ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]],
      'sliders-horizontal': [['path', { d: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3' }], ['path', { d: 'M14 2v4M8 10v4M16 18v4' }]],
      'git-merge': [['circle', { cx: 18, cy: 18, r: 3 }], ['circle', { cx: 6, cy: 6, r: 3 }], ['path', { d: 'M6 21V9a9 9 0 0 0 9 9' }]],
      minus: [['path', { d: 'M5 12h14' }]],
      plus: [['path', { d: 'M12 5v14M5 12h14' }]],
      scissors: [['circle', { cx: 6, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }], ['path', { d: 'M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12' }]],
      save: [['path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z' }], ['path', { d: 'M17 21v-8H7v8M7 3v5h8' }]],
      loader: [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]],
      check: [['path', { d: 'M20 6 9 17l-5-5' }]],
      'check-circle': [['path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }], ['path', { d: 'm9 11 3 3L22 4' }]],
      'alert-circle': [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 8v4M12 16h.01' }]],
      'rotate-ccw': [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }]],
      info: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 16v-4M12 8h.01' }]],
      sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41' }]],
      moon: [['path', { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' }]]
    }

    function Icon ({ name, size = 14, className, strokeWidth }) {
      const spec = ICONS[name]
      if (!spec) return null
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: strokeWidth || 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className,
        'aria-hidden': 'true',
        focusable: 'false'
      }, spec.map(([tag, attrs], index) => h(tag, { key: index, ...attrs })))
    }

    function GuideGlyph ({ size = 16 } = {}) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M5 6.2v3.6M8 5.4v5.2M11 6.2v3.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' })
      )
    }

    function toNumber (value) {
      const raw = String(value ?? '').trim()
      if (raw === '') return NaN
      return Number(raw)
    }

    function clamp (value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /** 引擎错误里会带 ANSI 颜色码，直接塞进面板会变成乱码。 */
    function stripAnsi (value) {
      return String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '')
    }

    function sameNumber (a, b) {
      const na = toNumber(a)
      const nb = toNumber(b)
      if (Number.isFinite(na) || Number.isFinite(nb)) return na === nb
      return String(a ?? '') === String(b ?? '')
    }

    function formatWhen (mtime) {
      const value = Number(mtime)
      if (!Number.isFinite(value) || value <= 0) return ''
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function AutoReelPanel ({ t }) {
      const [theme, setTheme] = useState(() => {
        try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' }
      })
      const [draft, setDraft] = useState({ replaysDir: '', sourcePath: '', outputDir: '', pre: '3.5', post: '1.5' })
      const [saved, setSaved] = useState(null)
      const [loaded, setLoaded] = useState(false)
      const [loadError, setLoadError] = useState(null)
      const [loadTick, setLoadTick] = useState(0)
      const [replays, setReplays] = useState([])
      const [listLoaded, setListLoaded] = useState(false)
      const [listError, setListError] = useState(null)
      const [spinning, setSpinning] = useState(false)
      const [refreshTick, setRefreshTick] = useState(0)
      const [saveState, setSaveState] = useState(null)
      const [cutError, setCutError] = useState(null)
      const [runId, setRunId] = useState(null)
      const [run, setRun] = useState(null)
      const [starting, setStarting] = useState(false)
      const [canceling, setCanceling] = useState(false)
      const [dismissedRunId, setDismissedRunId] = useState(null)
      const [revealState, setRevealState] = useState(null)
      const [picking, setPicking] = useState(null)
      const [menuOpen, setMenuOpen] = useState(false)
      const menuRef = useRef(null)
      const triggerRef = useRef(null)
      const savedDirRef = useRef('')
      const focusMenuRef = useRef(false)

      useEffect(() => {
        try { localStorage.setItem(THEME_KEY, theme) } catch {}
      }, [theme])

      useEffect(() => {
        let alive = true
        setLoadError(null)
        fetch(`${API}/settings`, { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!alive) return
            if (!ok || !data || !data.settings) {
              // 读不到设置就锁住表单：用空值保存会覆盖用户已有的配置
              setLoadError((data && data.error) || t('error.settings'))
              return
            }
            const s = data.settings
            const next = {
              replaysDir: s.replaysDir || '',
              sourcePath: s.sourcePath || '',
              outputDir: s.outputDir || '',
              pre: String(s.pre ?? 3.5),
              post: String(s.post ?? 1.5)
            }
            setDraft(next)
            setSaved(next)
            setLoadError(null)
            setLoaded(true)
          })
          .catch((error) => { if (alive) setLoadError(String((error && error.message) || error)) })
        return () => { alive = false }
      }, [loadTick])

      useEffect(() => {
        if (saved) savedDirRef.current = saved.replaysDir
      }, [saved])

      // 改回放目录时按新目录列文件（不必先保存）；刷新按钮走同一个 effect
      useEffect(() => {
        if (!loaded) return undefined
        const dir = String(draft.replaysDir || '').trim()
        setMenuOpen(false)
        if (!dir) {
          setReplays([])
          setListLoaded(true)
          setListError(null)
          setSpinning(false)
          return undefined
        }
        let alive = true
        setListLoaded(false)
        const timer = setTimeout(async () => {
          try {
            const response = await fetch(`${API}/replays?dir=${encodeURIComponent(dir)}`, { headers: { accept: 'application/json' } })
            const data = await response.json().catch(() => null)
            if (!alive) return
            setListLoaded(true)
            setSpinning(false)
            if (!response.ok) {
              setReplays([])
              setListError((data && data.error) || `接口返回 ${response.status}`)
              return
            }
            const items = data && Array.isArray(data.items) ? data.items : []
            setReplays(items)
            setListError(null)
            // 换了回放目录：旧目录里选中的文件不再属于当前列表，回退到「最新一条」
            setDraft((prev) => {
              if (!prev.sourcePath) return prev
              if (items.some((item) => item.path === prev.sourcePath)) return prev
              if (prev.replaysDir === savedDirRef.current) return prev
              return { ...prev, sourcePath: '' }
            })
          } catch (error) {
            if (alive) {
              setListLoaded(true)
              setSpinning(false)
              setReplays([])
              setListError(String((error && error.message) || error))
            }
          }
        }, 350)
        return () => { alive = false; clearTimeout(timer) }
      }, [draft.replaysDir, loaded, refreshTick])

      // 切走再回来（keepMounted 失效或页面重载）时，接回正在跑的任务
      useEffect(() => {
        if (!loaded || runId) return undefined
        let alive = true
        fetch(`${API}/runs/latest`, { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!alive || !ok || !data || !data.id) return
            if (data.id === dismissedRunId) return
            if (data.status === 'running') { setRun(data); setRunId(data.id) }
          })
          .catch(() => {})
        return () => { alive = false }
      }, [loaded, runId, dismissedRunId])

      // 轮询面板发起的 run
      useEffect(() => {
        if (!runId) return undefined
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const response = await fetch(`${API}/runs/${encodeURIComponent(runId)}`, { headers: { accept: 'application/json' } })
            const data = await response.json().catch(() => null)
            if (!alive) return
            if (response.status === 404) {
              // 插件重启后 run 记录没了：停止轮询，别每 1.2s 打一次
              setCutError(null)
              setCanceling(false)
              setRun((prev) => (prev ? { ...prev, status: 'failed', error: t('error.lost') } : prev))
              return
            }
            if (!response.ok) {
              setCutError(`接口返回 ${response.status}`)
              return
            }
            if (data && data.id) {
              setRun(data)
              setCutError(null)
              if (data.status === 'completed' || data.status === 'failed' || data.status === 'killed') {
                setCanceling(false)
                return
              }
            }
          } catch (error) {
            if (alive) setCutError(String((error && error.message) || error))
          }
          if (alive) timer = setTimeout(tick, 1200)
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [runId])

      useEffect(() => {
        if (!revealState) return undefined
        const timer = setTimeout(() => setRevealState(null), 2500)
        return () => clearTimeout(timer)
      }, [revealState])

      useEffect(() => {
        if (!saveState || saveState.kind !== 'saved') return undefined
        const timer = setTimeout(() => setSaveState(null), 2000)
        return () => clearTimeout(timer)
      }, [saveState])

      useEffect(() => {
        if (!menuOpen) return undefined
        const onDown = (event) => {
          if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setMenuOpen(false)
            if (triggerRef.current) triggerRef.current.focus()
          }
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [menuOpen])

      // 键盘打开下拉时把焦点移进菜单；鼠标打开保持焦点在触发器上
      useEffect(() => {
        if (!menuOpen || !focusMenuRef.current) return undefined
        focusMenuRef.current = false
        const timer = setTimeout(() => {
          const nodes = menuRef.current ? menuRef.current.querySelectorAll('.ar-option') : []
          const target = menuRef.current && menuRef.current.querySelector('.ar-option.is-selected')
          if (target && typeof target.focus === 'function') target.focus()
          else if (nodes.length > 0 && typeof nodes[0].focus === 'function') nodes[0].focus()
        }, 0)
        return () => clearTimeout(timer)
      }, [menuOpen])

      const moveMenuFocus = (step) => {
        if (!menuRef.current) return
        const nodes = Array.from(menuRef.current.querySelectorAll('.ar-option'))
        if (nodes.length === 0) return
        const current = nodes.indexOf(document.activeElement)
        let next
        if (step === 'first') next = 0
        else if (step === 'last') next = nodes.length - 1
        else {
          const from = current < 0 ? (step > 0 ? -1 : 0) : current
          next = clamp(from + step, 0, nodes.length - 1)
        }
        if (nodes[next] && typeof nodes[next].focus === 'function') nodes[next].focus()
      }

      const openMenu = (focus) => {
        focusMenuRef.current = Boolean(focus)
        setMenuOpen(true)
      }

      const closeMenu = (refocus) => {
        setMenuOpen(false)
        if (refocus && triggerRef.current) triggerRef.current.focus()
      }

      const set = (key, value) => {
        setDraft((prev) => ({ ...prev, [key]: value }))
        // 改动后“已保存 / 保存失败”就不作数了
        setSaveState((prev) => (prev && (prev.kind === 'saved' || prev.kind === 'error') ? null : prev))
      }

      /** 打开系统目录对话框，选中的路径写回对应字段。 */
      const pickDir = async (field) => {
        if (picking) return
        setPicking(field)
        try {
          const response = await fetch(`${API}/pick-dir`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data || !data.ok) {
            setSaveState({ kind: 'error', text: (data && data.error) || `浏览失败（HTTP ${response.status}）` })
            return
          }
          if (typeof data.path === 'string' && data.path) {
            set(field, data.path)
            setSaveState(null)
          }
        } catch (error) {
          setSaveState({ kind: 'error', text: String((error && error.message) || error) })
        } finally {
          setPicking(null)
        }
      }

      // 空字符串不能当成 0（Number('') === 0），否则清空输入框会被当成合法值
      const pre = toNumber(draft.pre)
      const post = toNumber(draft.post)
      const timingOk = Number.isFinite(pre) && Number.isFinite(post) && pre >= 0.5 && post >= 0.5 && pre <= 10 && post <= 10
      const total = timingOk && pre + post > 0 ? pre + post : 0
      const merge = timingOk ? (pre + post).toFixed(1) : '—'
      const prePct = total > 0 ? clamp((pre / total) * 100, 15, 85) : 50
      const postPct = 100 - prePct

      const dirty = Boolean(loaded && saved && (
        draft.replaysDir !== saved.replaysDir ||
        draft.sourcePath !== saved.sourcePath ||
        draft.outputDir !== saved.outputDir ||
        !sameNumber(draft.pre, saved.pre) ||
        !sameNumber(draft.post, saved.post)
      ))

      let pill = { kind: 'ok', text: t('status.synced') }
      if (loadError) pill = { kind: 'err', text: t('error.settings') }
      else if (!loaded) pill = { kind: 'busy', text: t('state.loading') }
      else if (saveState && saveState.kind === 'error') pill = { kind: 'err', text: saveState.text }
      else if (saveState && saveState.kind === 'saving') pill = { kind: 'busy', text: t('status.saving') }
      else if (saveState && saveState.kind === 'saved') pill = { kind: 'ok', text: t('status.saved') }
      else if (dirty) pill = { kind: 'warn', text: t('status.dirty') }

      const save = async () => {
        if (!Number.isFinite(pre) || pre < 0.5 || pre > 10) { setSaveState({ kind: 'error', text: t('error.pre') }); return }
        if (!Number.isFinite(post) || post < 0.5 || post > 10) { setSaveState({ kind: 'error', text: t('error.post') }); return }
        const submitted = { ...draft }
        setSaveState({ kind: 'saving', text: t('status.saving') })
        try {
          const response = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              replaysDir: submitted.replaysDir,
              sourcePath: submitted.sourcePath,
              outputDir: submitted.outputDir,
              pre,
              post
            })
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data || !data.ok) {
            setSaveState({ kind: 'error', text: (data && data.error) || `保存失败（HTTP ${response.status}）` })
            return
          }
          const s = data.settings
          const next = {
            replaysDir: s.replaysDir || '',
            sourcePath: s.sourcePath || '',
            outputDir: s.outputDir || '',
            pre: String(s.pre ?? pre),
            post: String(s.post ?? post)
          }
          setSaved(next)
          // 保存期间用户又改了输入：保留用户当前值，别用回包把它盖掉
          setDraft((prev) => (
            prev.replaysDir === submitted.replaysDir &&
            prev.sourcePath === submitted.sourcePath &&
            prev.outputDir === submitted.outputDir &&
            sameNumber(prev.pre, submitted.pre) &&
            sameNumber(prev.post, submitted.post)
          ) ? next : prev)
          setSaveState({ kind: 'saved', text: t('status.saved') })
        } catch (error) {
          setSaveState({ kind: 'error', text: String((error && error.message) || error) })
        }
      }

      const cut = async () => {
        if (starting || (run && run.status === 'running')) return
        if (!Number.isFinite(pre) || pre < 0.5 || pre > 10) { setCutError(t('error.pre')); return }
        if (!Number.isFinite(post) || post < 0.5 || post > 10) { setCutError(t('error.post')); return }
        // 改过回放目录后，旧目录里的选择不能拿来剪（避免误剪/覆盖旧成片）
        if (draft.sourcePath && saved && draft.replaysDir !== saved.replaysDir) {
          const norm = (value) => String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
          const prefix = norm(draft.replaysDir) + '\\'
          if (!norm(draft.sourcePath).startsWith(prefix)) { setCutError(t('error.staleSource')); return }
        }
        setCutError(null)
        setStarting(true)
        try {
          const response = await fetch(`${API}/cut`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: draft.sourcePath, replaysDir: draft.replaysDir, pre, post, outputDir: draft.outputDir })
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data || !data.ok) {
            setCutError((data && data.error) || `启动失败（HTTP ${response.status}）`)
            return
          }
          setDismissedRunId(null)
          setCanceling(false)
          setRun(data.run || null)
          setRunId(data.id)
        } catch (error) {
          setCutError(String((error && error.message) || error))
        } finally {
          setStarting(false)
        }
      }

      const cancelRun = async () => {
        if (!runId || canceling) return
        setCanceling(true)
        setCutError(null)
        try {
          const response = await fetch(`${API}/runs/${encodeURIComponent(runId)}/cancel`, {
            method: 'POST',
            // JSON content-type 让跨站请求必须走 preflight；本机接口没有 OPTIONS 处理
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}'
          })
          const data = await response.json().catch(() => null)
          if (!response.ok) {
            setCanceling(false)
            setCutError((data && data.error) || `取消失败（HTTP ${response.status}）`)
            return
          }
          if (data && data.run) setRun(data.run)
        } catch (error) {
          setCanceling(false)
          setCutError(String((error && error.message) || error))
        }
      }

      const reveal = async () => {
        const target = (run && run.output) || ''
        const stem = (run && run.stem) || ''
        if (!stem && !target) { setRevealState({ ok: false, text: t('error.noReel') }); return }
        // 主路径和工具卡片一致：走 DSH 的 open-in-app（页面内 fetch 自带鉴权）
        const dir = target ? dirnameOf(target) : ''
        if (dir && await openInFileManager(dir)) {
          setRevealState({ ok: true, text: t('state.opened') })
          return
        }
        try {
          const response = await fetch(`${API}/reveal`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stem, id: run && run.id ? run.id : '' })
          })
          const data = await response.json().catch(() => null)
          if (response.ok && data && data.ok !== false) setRevealState({ ok: true, text: t('state.opened') })
          else setRevealState({ ok: false, text: (data && data.error) || `打开失败（HTTP ${response.status}）` })
        } catch (error) {
          setRevealState({ ok: false, text: String((error && error.message) || error) })
        }
      }

      const collapse = () => {
        // 收起后别让 /runs/latest 把同一个任务又接回来
        if (runId) setDismissedRunId(runId)
        setRun(null)
        setRunId(null)
        setCutError(null)
        setRevealState(null)
        setCanceling(false)
        setStarting(false)
      }

      const step = (key, delta) => {
        const current = toNumber(draft[key])
        const base = Number.isFinite(current) ? current : (key === 'pre' ? 3.5 : 1.5)
        const next = clamp(Math.round((base + delta) * 2) / 2, 0.5, 10)
        set(key, next.toFixed(1))
      }

      const commit = (key) => {
        const current = toNumber(draft[key])
        if (!Number.isFinite(current)) return
        set(key, String(clamp(Math.round(current * 10) / 10, 0.5, 10)))
      }

      const usePreset = (preset) => {
        setDraft((prev) => ({ ...prev, pre: preset.pre.toFixed(1), post: preset.post.toFixed(1) }))
        setSaveState((prev) => (prev && (prev.kind === 'saved' || prev.kind === 'error') ? null : prev))
      }

      const refresh = () => {
        if (!draft.replaysDir) return
        setSpinning(true)
        setRefreshTick((n) => n + 1)
      }

      const status = run && run.status ? run.status : null
      const kills = run && Array.isArray(run.kills) ? run.kills : []
      const segments = run && Array.isArray(run.segments) ? run.segments : []
      const pct = clampPct(run && run.pct !== undefined ? run.pct : 0)
      const busy = status === 'running'
      const done = status === 'completed'
      const bad = status === 'failed' || status === 'killed'
      // 已保存的回放可能不在当前目录的列表里，仍要能在下拉里显示出来
      const straySource = listLoaded && draft.sourcePath && !replays.some((item) => item.path === draft.sourcePath)
        ? draft.sourcePath
        : ''
      // 列表还没回来时先用已保存路径的 basename，别闪一下「最新一条」
      const pendingSource = !listLoaded && draft.sourcePath
        ? { path: draft.sourcePath, name: basename(draft.sourcePath), sizeMb: null }
        : null
      const selected = replays.find((item) => item.path === draft.sourcePath) ||
        (straySource ? { path: straySource, name: `${basename(straySource)}${t('io.stray')}`, sizeMb: null } : null) ||
        pendingSource
      const sliderStyle = (value, colorVar) => {
        const safe = clamp(Number.isFinite(value) ? value : 0.5, 0.5, 10)
        const fill = ((safe - 0.5) / 9.5) * 100
        return { background: `linear-gradient(90deg, var(${colorVar}) 0%, var(${colorVar}) ${fill}%, var(--ar-line) ${fill}%, var(--ar-line) 100%)` }
      }
      const rangeLabel = (value) => (Number.isFinite(value) ? value.toFixed(1) : '—')

      const header = h('header', { className: 'ar-head' },
        h('div', { className: 'ar-brand' },
          h('div', { className: 'ar-mark' },
            h(Icon, { name: 'crosshair', size: 19, strokeWidth: 2.2 }),
            h('span', { className: 'ar-mark-dot' }, h('i', null))
          ),
          h('div', { className: 'ar-brand-text' },
            h('div', { className: 'ar-brand-row' },
              h('h1', { className: 'ar-title' }, 'AutoReel'),
              h('span', { className: 'ar-badge' }, t('brand.badge'))
            ),
            h('p', { className: 'ar-subtitle' }, t('brand.subtitle'))
          )
        ),
        h('div', { className: 'ar-head-actions' },
          h('span', { className: `ar-pill is-${pill.kind}`, title: pill.text, role: 'status', 'aria-live': 'polite' },
            h('i', { className: 'ar-dot' }),
            h('span', null, pill.text)
          ),
          h('button', {
            type: 'button',
            className: 'ar-icon-btn',
            title: t('theme.toggle'),
            'aria-label': t('theme.toggle'),
            'aria-pressed': theme === 'dark' ? 'true' : 'false',
            onClick: () => setTheme(theme === 'dark' ? 'light' : 'dark')
          }, h(Icon, { name: theme === 'dark' ? 'sun' : 'moon', size: 15 }))
        )
      )

      const loadingCard = h('div', { className: 'ar-card ar-loading' },
        h(Icon, { name: 'loader', size: 15, className: 'ar-spin' }),
        h('span', null, t('state.loading'))
      )

      const errorCard = h('div', { className: 'ar-card ar-loaderror' },
        h('div', { className: 'ar-loaderror-head' },
          h(Icon, { name: 'alert-circle', size: 16 }),
          h('span', null, t('error.settings'))
        ),
        h('div', { className: 'ar-alert' }, loadError),
        h('p', { className: 'ar-hint' }, t('error.settingsHint')),
        h('button', {
          type: 'button',
          className: 'ar-ghost',
          onClick: () => setLoadTick((n) => n + 1)
        }, h(Icon, { name: 'rotate-ccw', size: 12 }), t('state.retry'))
      )

      const sourceOptions = []
      sourceOptions.push(h('button', {
        key: '__latest',
        type: 'button',
        role: 'option',
        'aria-selected': !draft.sourcePath,
        tabIndex: -1,
        className: `ar-option${draft.sourcePath ? '' : ' is-selected'}`,
        onClick: () => { set('sourcePath', ''); closeMenu(true) }
      },
      h('span', { className: 'ar-option-main' },
        h('span', { className: 'ar-option-name' }, t('io.latest')),
        h('span', { className: 'ar-option-meta' }, `${t('io.latestDesc')}${replays[0] ? ` → ${replays[0].name}` : ''}`)
      ),
      h(Icon, { name: draft.sourcePath ? 'chevron-right' : 'check', size: 12 })
      ))
      if (straySource) {
        sourceOptions.push(h('button', {
          key: straySource,
          type: 'button',
          role: 'option',
          'aria-selected': true,
          tabIndex: -1,
          className: 'ar-option is-selected',
          onClick: () => { set('sourcePath', straySource); closeMenu(true) }
        },
        h('span', { className: 'ar-option-main' },
          h('span', { className: 'ar-option-name' }, `${basename(straySource)}${t('io.stray')}`),
          h('span', { className: 'ar-option-meta' }, straySource)
        ),
        h(Icon, { name: 'check', size: 12 })
        ))
      }
      for (const item of replays) {
        const isSel = item.path === draft.sourcePath
        sourceOptions.push(h('button', {
          key: item.path,
          type: 'button',
          role: 'option',
          'aria-selected': isSel,
          tabIndex: -1,
          className: `ar-option${isSel ? ' is-selected' : ''}`,
          onClick: () => { set('sourcePath', item.path); closeMenu(true) }
        },
        h('span', { className: 'ar-option-main' },
          h('span', { className: 'ar-option-name' }, item.name),
          h('span', { className: 'ar-option-meta' }, `${formatWhen(item.mtime)}${item.sizeMb ? ` · ${item.sizeMb} MB` : ''}${item.dvr ? ' · DVR' : ''}`)
        ),
        h(Icon, { name: isSel ? 'check' : 'chevron-right', size: 12 })
        ))
      }

      const inputCard = h('section', { className: 'ar-card' },
        h('div', { className: 'ar-card-head' },
          h('div', { className: 'ar-card-title' }, h(Icon, { name: 'folder', size: 15 }), h('h2', null, t('io.title'))),
          h('span', { className: 'ar-tag' }, t('io.tag'))
        ),
        h('div', { className: 'ar-card-body' },
          h('div', { className: 'ar-field' },
            h('label', { className: 'ar-label', htmlFor: 'auto-reel-replays' }, t('io.replaysDir')),
            h('div', { className: 'ar-inputgroup' },
              h('span', { className: 'ar-leading' }, h(Icon, { name: 'folder', size: 14 })),
              h('input', {
                id: 'auto-reel-replays',
                className: 'ar-input',
                value: draft.replaysDir,
                spellCheck: false,
                placeholder: 'C:\\Users\\you\\Videos\\VALORANT',
                onChange: (event) => set('replaysDir', event.target.value)
              }),
              h('button', {
                type: 'button',
                className: 'ar-browse',
                disabled: Boolean(picking),
                onClick: () => pickDir('replaysDir')
              }, picking === 'replaysDir' ? '…' : t('io.browse'))
            )
          ),
          h('div', { className: 'ar-field' },
            h('div', { className: 'ar-label-row' },
              h('label', { className: 'ar-label', htmlFor: 'auto-reel-source' }, t('io.source')),
              h('span', { className: 'ar-sublabel' }, !draft.replaysDir ? '—' : listError ? '' : (listLoaded ? `${replays.length} ${t('io.files')} · ${t('io.sourceHint')}` : t('io.busy')))
            ),
            h('div', { className: 'ar-source-row' },
              h('div', { className: 'ar-select-wrap', ref: menuRef },
                h('button', {
                  id: 'auto-reel-source',
                  ref: triggerRef,
                  type: 'button',
                  className: 'ar-select',
                  'aria-haspopup': 'listbox',
                  'aria-controls': 'auto-reel-source-menu',
                  'aria-expanded': menuOpen ? 'true' : 'false',
                  'aria-label': t('io.source'),
                  onClick: () => (menuOpen ? closeMenu(false) : openMenu(false)),
                  onKeyDown: (event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      if (!menuOpen) openMenu(true)
                      else moveMenuFocus(event.key === 'ArrowDown' ? 1 : -1)
                    } else if (event.key === 'Escape' && menuOpen) {
                      event.preventDefault()
                      closeMenu(true)
                    } else if (event.key === 'Tab' && menuOpen) {
                      setMenuOpen(false)
                    }
                  }
                },
                h(Icon, { name: 'film', size: 14 }),
                h('span', { className: `ar-file-name${selected ? '' : ' is-ghost'}`, title: selected ? selected.name : t('io.latest') }, selected ? selected.name : t('io.latest')),
                selected ? (selected.sizeMb != null ? h('span', { className: 'ar-size' }, `${selected.sizeMb} MB`) : null) : h('span', { className: 'ar-size is-ghost' }, t('io.latestChip')),
                h(Icon, { name: 'chevron-down', size: 14, className: `ar-chevron${menuOpen ? ' is-open' : ''}` })
                ),
                menuOpen && h('div', {
                  id: 'auto-reel-source-menu',
                  className: 'ar-menu',
                  role: 'listbox',
                  'aria-label': t('io.source'),
                  onKeyDown: (event) => {
                    if (event.key === 'ArrowDown') { event.preventDefault(); moveMenuFocus(1) } else if (event.key === 'ArrowUp') { event.preventDefault(); moveMenuFocus(-1) } else if (event.key === 'Home') { event.preventDefault(); moveMenuFocus('first') } else if (event.key === 'End') { event.preventDefault(); moveMenuFocus('last') } else if (event.key === 'Escape') { event.preventDefault(); closeMenu(true) } else if (event.key === 'Tab') { setMenuOpen(false) }
                  }
                }, sourceOptions)
              ),
              h('button', {
                type: 'button',
                className: 'ar-icon-btn is-square',
                title: t('io.refresh'),
                'aria-label': t('io.refresh'),
                disabled: !draft.replaysDir,
                onClick: refresh
              }, h(Icon, { name: 'refresh-cw', size: 15, className: spinning ? 'ar-spin' : '' }))
            ),
            listError && h('div', { className: 'ar-alert' }, listError),
            !listError && listLoaded && replays.length === 0 && h('div', { className: 'ar-hint' }, draft.replaysDir ? t('io.empty') : t('io.needDir'))
          ),
          h('div', { className: 'ar-field' },
            h('label', { className: 'ar-label', htmlFor: 'auto-reel-output' }, t('io.outputDir')),
            h('div', { className: 'ar-inputgroup' },
              h('span', { className: 'ar-leading' }, h(Icon, { name: 'folder-output', size: 14 })),
              h('input', {
                id: 'auto-reel-output',
                className: 'ar-input',
                value: draft.outputDir,
                spellCheck: false,
                placeholder: 'D:\\AutoReel\\out',
                onChange: (event) => set('outputDir', event.target.value)
              }),
              h('button', {
                type: 'button',
                className: 'ar-browse',
                disabled: Boolean(picking),
                onClick: () => pickDir('outputDir')
              }, picking === 'outputDir' ? '…' : t('io.browse'))
            )
          )
        )
      )

      const param = (key) => {
        const isPre = key === 'pre'
        const value = isPre ? pre : post
        const safeValue = Number.isFinite(value) ? clamp(value, 0.5, 10) : 3.5
        return h('div', { className: 'ar-param' },
          h('div', { className: 'ar-param-head' },
            h('span', { className: 'ar-param-label' },
              h('i', { className: `ar-param-dot ${isPre ? 'is-sky' : 'is-coral'}` }),
              t(isPre ? 'clip.pre' : 'clip.post')
            ),
            h('span', { className: 'ar-param-range' }, t('clip.range'))
          ),
          h('div', { className: 'ar-stepper' },
            h('button', { type: 'button', className: 'ar-step', 'aria-label': `${t(isPre ? 'clip.pre' : 'clip.post')} -0.5`, onClick: () => step(key, -0.5) }, h(Icon, { name: 'minus', size: 13 })),
            h('div', { className: `ar-num ${isPre ? 'is-pre' : 'is-post'}` },
              h('input', {
                type: 'number',
                min: 0.5,
                max: 10,
                step: 0.5,
                value: draft[key],
                'aria-label': t(isPre ? 'clip.pre' : 'clip.post'),
                onChange: (event) => set(key, event.target.value),
                onBlur: () => commit(key)
              }),
              h('span', { className: 'ar-num-unit' }, 's')
            ),
            h('button', { type: 'button', className: 'ar-step', 'aria-label': `${t(isPre ? 'clip.pre' : 'clip.post')} +0.5`, onClick: () => step(key, 0.5) }, h(Icon, { name: 'plus', size: 13 }))
          ),
          h('input', {
            type: 'range',
            min: 0.5,
            max: 10,
            step: 0.5,
            value: safeValue,
            className: `ar-slider ${isPre ? 'is-pre' : 'is-post'}`,
            style: sliderStyle(value, isPre ? '--ar-sky' : '--ar-coral'),
            'aria-label': t(isPre ? 'clip.pre' : 'clip.post'),
            onChange: (event) => set(key, event.target.value)
          })
        )
      }

      const clipCard = h('section', { className: 'ar-card' },
        h('div', { className: 'ar-card-head' },
          h('div', { className: 'ar-card-title' }, h(Icon, { name: 'sliders-horizontal', size: 15 }), h('h2', null, t('clip.title'))),
          h('div', { className: 'ar-presets', role: 'group', 'aria-label': t('clip.presets') },
            PRESETS.map((preset) => {
              const active = timingOk && Math.abs(pre - preset.pre) < 0.01 && Math.abs(post - preset.post) < 0.01
              return h('button', {
                key: preset.id,
                type: 'button',
                className: `ar-preset${active ? ' is-active' : ''}`,
                'aria-pressed': active ? 'true' : 'false',
                onClick: () => usePreset(preset)
              },
              h('span', null, t(`preset.${preset.id}`)),
              h('span', { className: 'ar-preset-num' }, `${preset.pre.toFixed(1)} / ${preset.post.toFixed(1)}`)
              )
            })
          )
        ),
        h('div', { className: `ar-timeline${timingOk ? '' : ' is-invalid'}` },
          h('div', { className: 'ar-timeline-top' },
            h('span', { className: 'ar-mergebadge' },
              h(Icon, { name: 'git-merge', size: 12 }),
              t('clip.merge'), ' ', h('b', null, merge), 's'
            ),
            h('p', { className: 'ar-mergehint' },
              t('clip.mergeHintA'), ' ', h('b', null, merge), 's ', t('clip.mergeHintB')
            )
          ),
          h('div', { className: 'ar-track-wrap' },
            h('div', { className: 'ar-pin', style: { left: `${prePct}%` } },
              h('span', { className: 'ar-pin-badge' }, h(Icon, { name: 'crosshair', size: 10 }), t('clip.killMoment'))
            ),
            h('div', { className: 'ar-bar' },
              h('div', { className: 'ar-bar-pre', style: { width: `${prePct}%` } },
                h('span', { className: 'ar-bar-label' }, `-${rangeLabel(pre)}s`)
              ),
              h('div', { className: 'ar-bar-post', style: { width: `${postPct}%` } },
                h('span', { className: 'ar-bar-label' }, `+${rangeLabel(post)}s`)
              )
            )
          ),
          h('div', { className: 'ar-legend' },
            h('span', null, h('i', { className: 'ar-dot-sky' }), t('clip.inPoint')),
            h('span', { className: 'ar-legend-total' }, t('clip.total'), ' ', h('b', null, `${merge}s`)),
            h('span', null, t('clip.outPoint'), h('i', { className: 'ar-dot-coral' }))
          )
        ),
        h('div', { className: 'ar-grid2' }, param('pre'), param('post'))
      )

      const progressTitle = busy ? t('progress.working') : done ? t('progress.done') : status === 'killed' ? t('progress.canceled') : status === 'failed' ? t('progress.failed') : t('progress.working')
      const progressSubtitle = basename((run && run.source) || draft.sourcePath) || t('io.latest')
      const liveMessage = busy ? t('progress.working') : done ? t('progress.done') : status === 'killed' ? t('progress.canceled') : status === 'failed' ? t('progress.failed') : ''

      const progressPanel = !run ? null : h('div', { className: 'ar-progress' },
        h('span', { className: 'ar-sr-only', role: 'status', 'aria-live': 'polite' }, liveMessage),
        h('div', { className: 'ar-progress-head' },
          h('div', { className: `ar-status-icon${done ? ' is-ok' : bad ? ' is-bad' : ''}` },
            h(Icon, { name: done ? 'check-circle' : bad ? 'alert-circle' : 'loader', size: 15, className: busy ? 'ar-spin' : '' })
          ),
          h('div', { className: 'ar-progress-copy' },
            h('p', { className: 'ar-progress-title' }, progressTitle),
            h('p', { className: 'ar-progress-sub', title: progressSubtitle }, progressSubtitle)
          ),
          h('div', { className: 'ar-progress-side' },
            h('span', { className: `ar-pct${done ? ' is-ok' : bad ? ' is-bad' : ''}` }, `${pct}%`),
            busy && h('button', { type: 'button', className: 'ar-cancel', disabled: canceling, onClick: cancelRun },
              canceling ? t('progress.canceling') : t('action.cancel')
            )
          )
        ),
        h('div', {
          className: 'ar-progress-track',
          role: 'progressbar',
          'aria-label': t('progress.label'),
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.round(pct)
        }, h('div', { className: `ar-progress-fill${done ? ' is-ok' : bad ? ' is-bad' : ''}`, style: { width: `${pct}%` } })),
        h('div', { className: 'ar-progress-meta' }, stripAnsi(run.progress) || t('progress.waiting')),
        done && h('div', { className: 'ar-result' },
          h('div', { className: 'ar-stats' },
            `${kills.length} ${t('unit.kills')} · ${segments.length} ${t('unit.segments')} · ${run.duration ?? '?'}s · ${run.sizeMb ?? '?'} MB`
          ),
          run.id && h('video', {
            key: run.id,
            className: 'ar-video',
            // 按 run 取：面板里改了输出目录但还没保存时，成片不在默认目录下
            src: `${MEDIA}/run/${encodeURIComponent(run.id)}/highlight_reel.mp4`,
            controls: true,
            preload: 'metadata',
            playsInline: true
          }),
          kills.length > 0 && h('div', { className: 'ar-kills' },
            kills.slice(0, 8).map((kill, index) => h('div', { key: `${kill.t}-${index}`, className: 'ar-kill' },
              h('span', { className: 'ar-kill-time' }, `${Number(kill.t).toFixed(1)}s`),
              h('span', { className: 'ar-kill-text' }, kill.text)
            )),
            kills.length > 8 ? h('div', { className: 'ar-kill-more', key: 'more' }, t('unit.more').replace('{n}', String(kills.length - 8))) : null
          ),
          h('div', { className: 'ar-result-row' },
            h('button', { type: 'button', className: 'ar-ghost', onClick: reveal },
              h(Icon, { name: 'folder-open', size: 12 }), t('action.open')
            ),
            revealState && h('span', { className: `ar-note ${revealState.ok ? 'is-ok' : 'is-bad'}` }, revealState.text),
            h('span', { className: 'ar-sr-only', role: 'status', 'aria-live': 'polite' }, revealState ? revealState.text : '')
          )
        ),
        status === 'failed' && h('div', { className: 'ar-alert', style: { marginTop: 9 } }, stripAnsi(run.error) || t('progress.failed')),
        bad && h('div', { className: 'ar-done-row' },
          h('span', { className: 'ar-done-text is-bad' },
            h(Icon, { name: 'alert-circle', size: 12 }),
            status === 'killed' ? t('progress.canceled') : t('progress.failed')
          ),
          h('div', { className: 'ar-done-actions' },
            h('button', { type: 'button', className: 'ar-ghost', onClick: collapse },
              h(Icon, { name: 'rotate-ccw', size: 12 }), t('action.dismiss')
            )
          )
        ),
        done && h('div', { className: 'ar-done-row' },
          h('span', { className: 'ar-done-text' },
            h(Icon, { name: 'check-circle', size: 12 }),
            t('progress.doneText').replace('{n}', String(segments.length))
          ),
          h('div', { className: 'ar-done-actions' },
            h('button', { type: 'button', className: 'ar-ghost', onClick: collapse },
              h(Icon, { name: 'rotate-ccw', size: 12 }), t('action.collapse')
            )
          )
        )
      )

      const actions = h('section', { className: 'ar-cta' },
        h('div', { className: 'ar-cta-row' },
          h('button', { type: 'button', className: 'ar-cut', disabled: busy || starting, onClick: cut },
            h(Icon, { name: starting || busy ? 'loader' : 'scissors', size: 16, className: starting || busy ? 'ar-spin' : '' }),
            h('span', null, starting || busy ? t('action.cutting') : t('action.cut'))
          ),
          h('button', {
            type: 'button',
            className: `ar-save${dirty ? ' is-dirty' : ''}`,
            disabled: !dirty || Boolean(saveState && saveState.kind === 'saving'),
            onClick: save
          },
          h(Icon, { name: 'save', size: 14 }),
          h('span', null, saveState && saveState.kind === 'saving' ? t('status.saving') : saveState && saveState.kind === 'saved' ? t('status.saved') : t('action.save')),
          dirty && h('i', { className: 'ar-unsaved' })
          )
        ),
        saveState && saveState.kind === 'error' && h('div', { className: 'ar-alert' }, saveState.text),
        cutError && h('div', { className: 'ar-alert' }, cutError),
        run && progressPanel
      )

      const footer = h('div', { className: 'ar-footer-note' },
        h(Icon, { name: 'info', size: 12 }),
        h('span', null, t('footer.hint'))
      )

      return h('div', { className: 'ar-root', 'data-theme': theme },
        h('style', null, PANEL_CSS),
        h('div', { className: 'ar-shell' },
          header,
          !loaded
            ? (loadError ? errorCard : loadingCard)
            : h(React.Fragment, null, inputCard, clipCard, actions, footer)
        )
      )
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply (ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICT), 'auto-reel: locale')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: PANEL_ID,
          kind: PANEL_KIND,
          keepMounted: true,
          title: () => t('tab.title'),
          guide: [{
            id: 'settings',
            order: 40,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: GuideGlyph
          }]
        }), 'auto-reel: sidebar tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PANEL_ID
        }, (props) => h(AutoReelPanel, { ...props, t }))), 'auto-reel: sidebar panel body')
        ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'auto_reel'
        }, HighlightCard)), 'auto-reel: tool card')
      }
    }
  }
})
