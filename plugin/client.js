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
    const { useState, useEffect, useMemo, useCallback } = React
    const API = '/autoreel/api'
    const MEDIA = '/autoreel/media'
    const MAX_KILLS = 8

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

      const victimOf = (text) => {
        if (typeof text !== 'string') return ''
        return localId && text.startsWith(localId) ? text.slice(localId.length) : text
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
    const SETTINGS_HINT = '设置保存在本机设置文件里，保存后立即生效（不用重启插件）。'
    const DICT = {
      zh: {
        'tab.title': 'AutoReel',
        'guide.title': 'AutoReel 设置',
        'guide.description': '选回放、输出目录与击杀前后秒数，直接出片',
        'input.section': '输入',
        'input.replaysDir': '回放目录',
        'input.source': '回放文件',
        'input.latest': '最新一条（自动）',
        'input.outputDir': '输出目录',
        'clip.section': '剪辑',
        'clip.pre': '击杀前（秒）',
        'clip.post': '击杀后（秒）',
        'clip.merge': '合并阈值',
        'action.cut': '剪这条回放',
        'action.save': '保存设置',
        'save.hint': '保存后，聊天里调用 auto_reel 也会用这些值',
        'action.browse': '浏览…',
        'action.refresh': '刷新',
        'action.open': '打开目录',
        'state.loading': '读取设置…',
        'state.saving': '保存中…',
        'state.saved': '已保存',
        'state.cutting': '剪辑中',
        'state.ready': '就绪',
        'state.opened': '已打开目录',
        'error.pre': '击杀前秒数需要 0–10',
        'error.post': '击杀后秒数需要 0–10',
        'error.settings': '读取设置失败',
        'error.noReel': '还没有成片',
        'error.lost': '任务记录已丢失（插件可能重启过）',
        'input.stray': '（不在当前目录）',
        'empty.replays': '这个目录里没有录像',
        'unit.kills': '次击杀',
        'unit.segments': '段',
        hint: SETTINGS_HINT
      },
      en: {
        'tab.title': 'AutoReel',
        'guide.title': 'AutoReel settings',
        'guide.description': 'Pick a replay, output folder and the seconds around each kill, then cut',
        'input.section': 'Input',
        'input.replaysDir': 'Replays folder',
        'input.source': 'Replay file',
        'input.latest': 'Latest (auto)',
        'input.outputDir': 'Output folder',
        'clip.section': 'Clip',
        'clip.pre': 'Seconds before',
        'clip.post': 'Seconds after',
        'clip.merge': 'Merge window',
        'action.cut': 'Cut this replay',
        'action.save': 'Save settings',
        'save.hint': 'Also used by auto_reel runs started from chat',
        'action.browse': 'Browse…',
        'action.refresh': 'Refresh',
        'action.open': 'Open folder',
        'state.loading': 'Loading settings…',
        'state.saving': 'Saving…',
        'state.saved': 'Saved',
        'state.cutting': 'Cutting',
        'state.ready': 'Ready',
        'state.opened': 'Folder opened',
        'error.pre': 'Seconds before must be 0–10',
        'error.post': 'Seconds after must be 0–10',
        'error.settings': 'Could not load settings',
        'error.noReel': 'No reel yet',
        'error.lost': 'Run record is gone (plugin may have restarted)',
        'input.stray': ' (not in this folder)',
        'empty.replays': 'No replays in this folder',
        'unit.kills': 'kills',
        'unit.segments': 'segments',
        hint: 'Settings are stored on this machine and apply immediately, no plugin restart.'
      }
    }

    const panelStyles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        height: '100%',
        overflow: 'auto',
        boxSizing: 'border-box',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)'
      },
      section: { display: 'flex', flexDirection: 'column', gap: 6 },
      sectionTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        fontFamily: 'inherit'
      },
      row: { display: 'flex', gap: 8, alignItems: 'center' },
      two: { display: 'flex', gap: 10 },
      half: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
      btn: {
        flex: '0 0 auto',
        fontSize: 12,
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontFamily: 'inherit'
      },
      primary: {
        flex: '1 1 auto',
        fontSize: 13,
        fontWeight: 600,
        padding: '7px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
        fontFamily: 'inherit'
      },
      primaryOff: { opacity: 0.5, cursor: 'default' },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      ok: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' },
      bad: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' },
      track: { height: 4, borderRadius: 2, background: 'var(--dsw-alias-border-l2)', overflow: 'hidden' },
      fill: { height: '100%', borderRadius: 2, background: 'var(--dsw-alias-brand-primary)', transition: 'width .3s ease' },
      video: { width: '100%', maxHeight: 220, borderRadius: 8, background: '#000', display: 'block' },
      kill: { display: 'flex', gap: 8, fontSize: 12, alignItems: 'baseline' },
      killTime: { width: 46, textAlign: 'right', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }
    }

    function GuideGlyph ({ size = 16 } = {}) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M5 6.2v3.6M8 5.4v5.2M11 6.2v3.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' })
      )
    }

    function AutoReelPanel ({ t }) {
      const [draft, setDraft] = useState({ replaysDir: '', sourcePath: '', outputDir: '', pre: '3.5', post: '1.5' })
      const [loaded, setLoaded] = useState(false)
      const [replays, setReplays] = useState([])
      const [listLoaded, setListLoaded] = useState(false)
      const [listError, setListError] = useState(null)
      const [saveState, setSaveState] = useState(null)
      const [cutError, setCutError] = useState(null)
      const [runId, setRunId] = useState(null)
      const [run, setRun] = useState(null)
      const [settingsFile, setSettingsFile] = useState('')
      const [revealState, setRevealState] = useState(null)
      const [picking, setPicking] = useState(null)

      useEffect(() => {
        let alive = true
        fetch(`${API}/settings`, { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!alive) return
            if (!ok || !data || !data.settings) {
              setSaveState({ kind: 'error', text: (data && data.error) || t('error.settings') })
              setLoaded(true)
              return
            }
            const s = data.settings
            setDraft({
              replaysDir: s.replaysDir || '',
              sourcePath: s.sourcePath || '',
              outputDir: s.outputDir || '',
              pre: String(s.pre ?? 3.5),
              post: String(s.post ?? 1.5)
            })
            setSettingsFile(data.file || '')
            setLoaded(true)
          })
          .catch((error) => { if (alive) { setSaveState({ kind: 'error', text: String((error && error.message) || error) }); setLoaded(true) } })
        return () => { alive = false }
      }, [])

      // 改回放目录时按新目录列文件（不必先保存）
      useEffect(() => {
        if (!loaded || !draft.replaysDir) return undefined
        let alive = true
        setListLoaded(false)
        const timer = setTimeout(async () => {
          try {
            const response = await fetch(`${API}/replays?dir=${encodeURIComponent(draft.replaysDir)}`, { headers: { accept: 'application/json' } })
            const data = await response.json().catch(() => null)
            if (!alive) return
            setListLoaded(true)
            if (!response.ok) {
              setReplays([])
              setListError((data && data.error) || `接口返回 ${response.status}`)
              return
            }
            setReplays(data && Array.isArray(data.items) ? data.items : [])
            setListError(null)
          } catch (error) {
            if (alive) { setListLoaded(true); setReplays([]); setListError(String((error && error.message) || error)) }
          }
        }, 350)
        return () => { alive = false; clearTimeout(timer) }
      }, [draft.replaysDir, loaded])

      // 切走再回来（keepMounted 失效或页面重载）时，接回正在跑的任务
      useEffect(() => {
        if (!loaded || runId) return undefined
        let alive = true
        fetch(`${API}/runs/latest`, { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!alive || !ok || !data || !data.id) return
            if (data.status === 'running') { setRun(data); setRunId(data.id) }
          })
          .catch(() => {})
        return () => { alive = false }
      }, [loaded, runId])

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
              setCutError(t('error.lost'))
              setRun((prev) => (prev ? { ...prev, status: 'failed', error: t('error.lost') } : prev))
              return
            }
            if (!response.ok) {
              setCutError(`接口返回 ${response.status}`)
              return
            }
            if (data && data.id) {
              setRun(data)
              if (data.status === 'completed' || data.status === 'failed' || data.status === 'killed') return
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

      const set = (key, value) => {
        setDraft((prev) => ({ ...prev, [key]: value }))
        // 改动后“已保存”就不作数了
        setSaveState((prev) => (prev && prev.kind === 'saved' ? null : prev))
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
      const pre = String(draft.pre).trim() === '' ? NaN : Number(draft.pre)
      const post = String(draft.post).trim() === '' ? NaN : Number(draft.post)
      const merge = Number.isFinite(pre) && Number.isFinite(post) ? (pre + post).toFixed(1) : '—'

      const save = async () => {
        if (!Number.isFinite(pre) || pre < 0 || pre > 10) { setSaveState({ kind: 'error', text: t('error.pre') }); return }
        if (!Number.isFinite(post) || post < 0 || post > 10) { setSaveState({ kind: 'error', text: t('error.post') }); return }
        setSaveState({ kind: 'saving', text: t('state.saving') })
        try {
          const response = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              replaysDir: draft.replaysDir,
              sourcePath: draft.sourcePath,
              outputDir: draft.outputDir,
              pre,
              post
            })
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data || !data.ok) {
            setSaveState({ ok: false, text: (data && data.error) || `保存失败（HTTP ${response.status}）` })
            return
          }
          const s = data.settings
          setDraft({
            replaysDir: s.replaysDir || '',
            sourcePath: s.sourcePath || '',
            outputDir: s.outputDir || '',
            pre: String(s.pre ?? pre),
            post: String(s.post ?? post)
          })
          setSaveState({ kind: 'saved', text: t('state.saved') })
        } catch (error) {
          setSaveState({ kind: 'error', text: String((error && error.message) || error) })
        }
      }

      const cut = async () => {
        setCutError(null)
        setRun(null)
        setRunId(null)
        if (!Number.isFinite(pre) || pre < 0 || pre > 10) { setCutError(t('error.pre')); return }
        if (!Number.isFinite(post) || post < 0 || post > 10) { setCutError(t('error.post')); return }
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
          setRun(data.run || null)
          setRunId(data.id)
        } catch (error) {
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

      const status = run && run.status ? run.status : null
      const kills = run && Array.isArray(run.kills) ? run.kills : []
      const pct = clampPct(run && run.pct !== undefined ? run.pct : 0)
      const busy = status === 'running'
      const done = status === 'completed'
      const bad = status === 'failed' || status === 'killed'
      // 已保存的回放可能不在当前目录的列表里，仍要能在下拉里显示出来
      const straySource = listLoaded && draft.sourcePath && !replays.some((item) => item.path === draft.sourcePath)
        ? draft.sourcePath
        : ''

      if (!loaded) {
        return h('div', { style: panelStyles.root }, h('div', { style: panelStyles.hint }, t('state.loading')))
      }

      return h('div', { style: panelStyles.root },
        h('div', { style: panelStyles.section },
          h('div', { style: panelStyles.sectionTitle }, t('input.section')),
          h('label', { style: panelStyles.label, htmlFor: 'auto-reel-replays' }, t('input.replaysDir')),
          h('div', { style: panelStyles.row },
            h('input', {
              id: 'auto-reel-replays',
              style: panelStyles.input,
              value: draft.replaysDir,
              spellCheck: false,
              onChange: (event) => set('replaysDir', event.target.value)
            }),
            h('button', {
              type: 'button',
              style: panelStyles.btn,
              disabled: Boolean(picking),
              onClick: () => pickDir('replaysDir')
            }, picking === 'replaysDir' ? '…' : t('action.browse'))
          ),
          h('label', { style: panelStyles.label, htmlFor: 'auto-reel-source' }, t('input.source')),
          h('select', {
            id: 'auto-reel-source',
            style: panelStyles.input,
            value: draft.sourcePath,
            onChange: (event) => set('sourcePath', event.target.value)
          },
          h('option', { value: '' }, t('input.latest')),
          straySource ? h('option', { key: straySource, value: straySource }, `${basename(straySource)}${t('input.stray')}`) : null,
          replays.map((item) => h('option', { key: item.path, value: item.path }, `${item.name}${item.sizeMb ? ` · ${item.sizeMb} MB` : ''}`))
          ),
          listError && h('div', { style: panelStyles.bad }, listError),
          !listError && listLoaded && replays.length === 0 && h('div', { style: panelStyles.hint }, t('empty.replays')),
          h('label', { style: panelStyles.label, htmlFor: 'auto-reel-output' }, t('input.outputDir')),
          h('div', { style: panelStyles.row },
            h('input', {
              id: 'auto-reel-output',
              style: panelStyles.input,
              value: draft.outputDir,
              spellCheck: false,
              onChange: (event) => set('outputDir', event.target.value)
            }),
            h('button', {
              type: 'button',
              style: panelStyles.btn,
              disabled: Boolean(picking),
              onClick: () => pickDir('outputDir')
            }, picking === 'outputDir' ? '…' : t('action.browse'))
          )
        ),
        h('div', { style: panelStyles.section },
          h('div', { style: panelStyles.sectionTitle }, t('clip.section')),
          h('div', { style: panelStyles.two },
            h('div', { style: panelStyles.half },
              h('label', { style: panelStyles.label, htmlFor: 'auto-reel-pre' }, t('clip.pre')),
              h('input', {
                id: 'auto-reel-pre',
                type: 'number', min: 0, max: 10, step: 0.5,
                style: panelStyles.input,
                value: draft.pre,
                onChange: (event) => set('pre', event.target.value)
              })
            ),
            h('div', { style: panelStyles.half },
              h('label', { style: panelStyles.label, htmlFor: 'auto-reel-post' }, t('clip.post')),
              h('input', {
                id: 'auto-reel-post',
                type: 'number', min: 0, max: 10, step: 0.5,
                style: panelStyles.input,
                value: draft.post,
                onChange: (event) => set('post', event.target.value)
              })
            )
          ),
          h('div', { style: panelStyles.hint }, `${t('clip.merge')} ${merge}s`)
        ),
        h('div', { style: panelStyles.row },
          h('button', {
            type: 'button',
            style: busy ? { ...panelStyles.primary, ...panelStyles.primaryOff } : panelStyles.primary,
            disabled: busy,
            onClick: cut
          }, busy ? t('state.cutting') : t('action.cut')),
          h('button', { type: 'button', style: panelStyles.btn, onClick: save }, t('action.save'))
        ),
        h('div', { style: panelStyles.hint }, t('save.hint')),
        h('div', { role: 'status', 'aria-live': 'polite' },
          saveState && h('div', {
            style: saveState.kind === 'error' ? panelStyles.bad : (saveState.kind === 'saved' ? panelStyles.ok : panelStyles.hint)
          }, saveState.text),
          cutError && h('div', { style: panelStyles.bad }, cutError)
        ),
        run && h('div', { style: panelStyles.section },
          busy && h('div', null,
            h('div', {
              style: panelStyles.track,
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(pct)
            }, h('div', { style: { ...panelStyles.fill, width: `${pct}%` } })),
            h('div', { style: panelStyles.hint }, `${Math.round(pct)}% ${run.progress || ''}`)
          ),
          done && h('div', { style: panelStyles.hint },
            `${kills.length} ${t('unit.kills')} · ${(run.segments || []).length} ${t('unit.segments')} · ${run.duration ?? '?'}s · ${run.sizeMb ?? '?'} MB`),
          done && run.id && h('video', {
            key: run.id || run.mediaUrl,
            // 按 run 取：面板里改了输出目录但还没保存时，成片不在默认目录下
            style: panelStyles.video,
            src: `${MEDIA}/run/${encodeURIComponent(run.id)}/highlight_reel.mp4`,
            controls: true,
            preload: 'metadata',
            playsInline: true
          }),
          kills.slice(0, 5).map((kill, index) => h('div', { key: `${kill.t}-${index}`, style: panelStyles.kill },
            h('span', { style: panelStyles.killTime }, `${Number(kill.t).toFixed(1)}s`),
            h('span', null, kill.text)
          )),
          done && h('div', { style: panelStyles.row },
            h('button', { type: 'button', style: panelStyles.btn, onClick: reveal }, t('action.open')),
            revealState && h('span', { style: revealState.ok ? panelStyles.ok : panelStyles.bad }, revealState.text)
          ),
          bad && h('div', { style: panelStyles.bad }, run.error || status)
        ),
        h('div', { style: panelStyles.hint },
          t('hint'),
          settingsFile ? h('div', null, settingsFile) : null
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
