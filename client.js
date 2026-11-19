/**
 * Client half of dsh-grouped-sessions: the sidebar workspace → group → session tree.
 *
 * The plugin takes over the shell's workspace/session browsing region
 * (`sidebar.workspaces`) because groups must live *inside* the session list,
 * not on a separate page: the user opens a workspace, picks a group, picks a
 * session. The official region is a single slot, so taking it over is the only
 * way to put group rows between workspaces and sessions.
 *
 * Three rules keep that takeover safe:
 *  - the official occupant is kept and rendered again by an error boundary if
 *    our tree throws, so a bug can never blank the whole left column;
 *  - the official props (`useWorkspaces`, `useSessions`, `wide`, …) are reused
 *    as-is rather than re-deriving state from services;
 *  - nothing outside the region's own subtree is touched.
 *
 * Groups live on the Host (`index.js`), kept in `~/.dsh/dsh-grouped-sessions.json`
 * and read/written over the plugin's own loopback route family.
 */

window.__ModuleLoader__.load({
  id: 'dsh-grouped-sessions',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Route family served by the Host half. */
    const API = '/api/dsh-grouped-sessions'

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-grouped-sessions'

    /** Where this plugin keeps its own view state (expanded rows, filter). */
    const VIEW_KEY = 'dsh-session-groups.sidebar'

    /**
     * Pseudo-group id prefix for the "Ungrouped" bucket of one workspace. The
     * bucket shares the collapse map with real groups, so it needs a key that
     * can never collide with a group id (those are `group-<uuid>`).
     */
    const UNGROUPED_PREFIX = 'ungrouped:'

    /* ------------------------------------------------------------------ locale */

    const EN = {
      'tree.title': 'Groups',
      'tree.newGroup': 'New group',
      'tree.newSession': 'New session',
      'tree.search': 'Filter sessions',
      'tree.searchPlaceholder': 'Filter sessions',
      'tree.empty': 'No session yet.',
      'tree.noWorkspace': 'No workspace yet.',
      'tree.ungrouped': 'Ungrouped',
      'tree.noGroup': 'No group yet. Use + to create one.',
      'tree.groupMenu': 'Group actions',
      'tree.ungroupedMenu': 'Ungrouped actions',
      'tree.sessionMenu': 'Session actions',
      'tree.toggleGroup': 'Toggle group {name}',
      'tree.toggleWorkspace': 'Toggle workspace {name}',
      'tree.moveTo': 'Move to group',
      'tree.moveOut': 'Remove from group',
      'tree.renameGroup': 'Rename group',
      'tree.moveUp': 'Move up',
      'tree.moveDown': 'Move down',
      'tree.deleteGroup': 'Delete group',
      'tree.dropGroup': 'Drop to file here',
      'tree.dropUngrouped': 'Drop to unfiled',
      'tree.noMatch': 'No session matches.',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.retry': 'Retry',
      'confirm.delete': 'Delete the group "{name}"? Its sessions stay in the workspace.',
      'prompt.groupName': 'Group name',
      'error.load': 'Groups could not be loaded.',
      'error.missing-name': 'Give the group a name.',
      'error.missing-workspace': 'Open a workspace first.',
      'error.missing-session': 'That session no longer exists.',
      'error.unknown-group': 'That group no longer exists.',
      'error.unknown-action': 'This change is not supported.',
      'error.invalid-direction': 'That move is not supported.',
      'error.body-too-large': 'The change is too large.',
      'error.invalid-body': 'The change could not be read.',
      'error.failed': 'The change was rejected.',
      'time.now': 'now',
      'time.minutes': '{count}m',
      'time.hours': '{count}h',
      'time.days': '{count}d',
      'title.untitled': 'Untitled',
      'title.defaultName': 'Untitled workspace',
    }

    const ZH = {
      'tree.title': '分组',
      'tree.newGroup': '新建分组',
      'tree.newSession': '新建会话',
      'tree.search': '筛选会话',
      'tree.searchPlaceholder': '筛选会话',
      'tree.empty': '还没有会话。',
      'tree.noWorkspace': '还没有工作区。',
      'tree.ungrouped': '未分组',
      'tree.noGroup': '还没有分组，点 ＋ 新建一个。',
      'tree.groupMenu': '分组操作',
      'tree.ungroupedMenu': '未分组操作',
      'tree.sessionMenu': '会话操作',
      'tree.toggleGroup': '展开或收起分组「{name}」',
      'tree.toggleWorkspace': '展开或收起工作区「{name}」',
      'tree.moveTo': '移动到分组',
      'tree.moveOut': '移出分组',
      'tree.renameGroup': '重命名分组',
      'tree.moveUp': '上移',
      'tree.moveDown': '下移',
      'tree.deleteGroup': '删除分组',
      'tree.dropGroup': '松开即归入该分组',
      'tree.dropUngrouped': '松开即移出分组',
      'tree.noMatch': '没有匹配的会话。',
      'action.save': '保存',
      'action.cancel': '取消',
      'action.retry': '重试',
      'confirm.delete': '删除分组「{name}」？其中的会话仍保留在工作区里。',
      'prompt.groupName': '分组名称',
      'error.load': '分组加载失败。',
      'error.missing-name': '请给分组起个名字。',
      'error.missing-workspace': '请先打开一个工作区。',
      'error.missing-session': '这个会话已不存在。',
      'error.unknown-group': '这个分组已不存在。',
      'error.unknown-action': '不支持这个改动。',
      'error.invalid-direction': '不支持这个移动方向。',
      'error.body-too-large': '改动内容过大。',
      'error.invalid-body': '改动内容无法读取。',
      'error.failed': '改动被拒绝。',
      'time.now': '刚刚',
      'time.minutes': '{count} 分钟',
      'time.hours': '{count} 小时',
      'time.days': '{count} 天',
      'title.untitled': '未命名会话',
      'title.defaultName': '未命名工作区',
    }

    let translate = key => (EN[key] !== undefined ? EN[key] : key)

    /** Locale service handle; late-bound because the service may not exist yet. */
    let localeService = null

    /** Components subscribe here to re-render when the bound locale changes. */
    const localeListeners = new Set()

    function notifyLocale() {
      for (const listener of [...localeListeners]) {
        try {
          listener()
        } catch (error) {
          console.warn('[dsh-grouped-sessions] locale listener failed:', error)
        }
      }
    }

    /** Point `translate` at the locale service (no-op object if absent). */
    function bindLocale(service) {
      localeService = service
      translate = typeof service.bind === 'function'
        ? service.bind(NS)
        : key => (EN[key] !== undefined ? EN[key] : key)
      notifyLocale()
    }

    /** Re-render the calling component whenever the language changes. */
    function useLocaleRevision() {
      const [, setRevision] = React.useState(0)
      React.useEffect(() => {
        const listener = () => setRevision(previous => previous + 1)
        localeListeners.add(listener)
        return () => {
          localeListeners.delete(listener)
        }
      }, [])
    }

    /** Translate `key`, substituting `{name}` style parameters. */
    function t(key, params) {
      const template = translate(key)
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
    }

    /* ------------------------------------------------------------------- style */

    const STYLE_ID = 'dsh-grouped-sessions/sidebar.css'

    const CSS = `
.sg-root{display:flex;flex-direction:column;min-height:0;flex:1;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-sidebar-fill)}
.sg-root,.sg-root *{box-sizing:border-box}
.sg-top{display:flex;align-items:center;gap:4px;padding:2px 8px 4px 8px;min-height:28px}
.sg-top-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sg-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.sg-icon-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.sg-icon-btn[aria-pressed='true']{color:var(--dsw-alias-brand-primary)}
.sg-icon-btn:focus-visible,.sg-row-hit:focus-visible,.sg-group-row:focus-visible,.sg-ws-row:focus-visible,.sg-menu-item:focus-visible,.sg-link:focus-visible,.sg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.sg-search{padding:0 8px 4px 8px}
.sg-search-input{width:100%;box-sizing:border-box;height:26px;padding:0 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px}
.sg-search-input::placeholder{color:var(--dsw-alias-label-secondary)}
.sg-list{display:flex;flex-direction:column;gap:1px;min-height:0;overflow-y:auto;padding:0 4px 8px 4px}
.sg-ws{display:flex;flex-direction:column;gap:1px;margin-top:4px}
.sg-ws-row{display:flex;align-items:center;gap:4px;min-height:26px;padding:0 4px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:600;letter-spacing:.02em;text-align:left;cursor:pointer;width:100%}
.sg-ws-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.sg-ws-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none}
.sg-chevron{display:inline-flex;width:12px;height:12px;flex:none;transition:transform .12s ease}
.sg-chevron-open{transform:rotate(90deg)}
.sg-group{position:relative;display:flex;flex-direction:column;gap:1px;margin:1px 0 2px 6px;padding-left:6px;border-left:1px solid var(--dsw-alias-border-l1)}
.sg-group-row{display:flex;align-items:center;gap:4px;min-height:26px;padding:0 4px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:500;text-align:left;cursor:pointer;width:100%}
.sg-group-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.sg-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sg-group-count{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.sg-group-main{display:flex;align-items:center;gap:2px}
.sg-ws-main{display:flex;align-items:center;gap:2px}
.sg-group-drop .sg-group-row{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.sg-rows{display:flex;flex-direction:column;gap:1px}
.sg-row{display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:0 4px 0 6px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.sg-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.sg-row-current{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}.sg-row-current .sg-row-title{color:var(--dsw-alias-brand-primary);font-weight:500}
.sg-row-hit{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sg-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.sg-dot-running{background:var(--dsw-alias-state-success-primary)}
.sg-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sg-row-time{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.sg-menu-wrap{position:relative;display:flex;flex-direction:column}
.sg-menu{display:flex;flex-direction:column;gap:1px;margin:2px 0 4px 0;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.sg-menu-label{padding:2px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.sg-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:26px;padding:0 6px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.sg-menu-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.sg-menu-item[aria-checked='true']{color:var(--dsw-alias-brand-primary)}
.sg-menu-item-danger{color:var(--dsw-alias-state-error-primary)}
.sg-check{width:12px;flex:none;font-size:11px;text-align:center}
.sg-empty{padding:8px 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sg-error{display:flex;align-items:center;gap:6px;margin:2px 6px 4px 6px;padding:4px 6px;border-radius:6px;font-size:12px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.sg-error-text{flex:1;min-width:0}
.sg-form-error{padding:0 2px}
.sg-link{border:none;background:transparent;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline}
.sg-inline-form{display:flex;flex-direction:column;gap:4px;margin:2px 4px 4px 4px;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.sg-input{width:100%;box-sizing:border-box;height:26px;padding:0 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px}
.sg-form-actions{display:flex;gap:4px;justify-content:flex-end}
.sg-btn{height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.sg-btn:disabled{opacity:.5;cursor:default}
.sg-btn-primary{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-base));color:var(--dsw-alias-brand-primary)}
.sg-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.sg-hint{position:absolute;top:2px;right:4px;padding:1px 5px;border-radius:5px;font-size:11px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-base));pointer-events:none}
`

    /** Append the stylesheet once; returns a disposer. */
    function ensureStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) {
        return () => {
          if (existing.parentNode !== null) existing.parentNode.removeChild(existing)
        }
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin-css', STYLE_ID)
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        if (style.parentNode !== null) style.parentNode.removeChild(style)
      }
    }

    /* ------------------------------------------------------------------ transport */

    async function loadGroups() {
      const response = await fetch(API + '/state', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error('state failed: ' + response.status)
      const body = await response.json()
      return Array.isArray(body.groups) ? body.groups : []
    }

    async function mutateGroups(payload) {
      const response = await fetch(API + '/mutate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        body = null
      }
      if (!response.ok) {
        const code = body !== null && typeof body.error === 'string' ? body.error : 'failed'
        const error = new Error(code)
        error.code = code
        throw error
      }
      return body !== null && Array.isArray(body.groups) ? body.groups : []
    }

    /** Map a host error code onto localized copy. */
    function errorText(error) {
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'failed'
      const key = 'error.' + code
      if (translate(key) === key) {
        console.warn('[dsh-grouped-sessions] unmapped host error:', code, error)
        return t('error.failed')
      }
      return t(key)
    }

    /* ------------------------------------------------------------------- helpers */

    /**
     * Persisted view state.
     *
     * Groups are closed by default, so the stored side is the list of groups the
     * user opened (`expandedGroups`), not the list of closed ones. The older
     * `collapsedGroups` field is deliberately ignored: a stored "not collapsed"
     * set would have meant every group opening on upgrade, which is the opposite
     * of the default this field exists for.
     */
    function readView() {
      const empty = { collapsedWorkspaces: [], expandedGroups: [], collapsedUngrouped: [], ungroupedOrder: {} }
      try {
        const raw = window.localStorage.getItem(VIEW_KEY)
        if (raw === null) return empty
        const parsed = JSON.parse(raw)
        const storedOrder = parsed !== null && typeof parsed.ungroupedOrder === 'object' && parsed.ungroupedOrder !== null
          ? parsed.ungroupedOrder
          : {}
        const ungroupedOrder = {}
        for (const [workspaceId, value] of Object.entries(storedOrder)) {
          if (typeof value === 'number' && Number.isFinite(value)) ungroupedOrder[workspaceId] = value
        }
        return {
          collapsedWorkspaces: Array.isArray(parsed.collapsedWorkspaces) ? parsed.collapsedWorkspaces : [],
          expandedGroups: Array.isArray(parsed.expandedGroups) ? parsed.expandedGroups : [],
          collapsedUngrouped: Array.isArray(parsed.collapsedUngrouped) ? parsed.collapsedUngrouped : [],
          ungroupedOrder,
        }
      } catch (error) {
        return empty
      }
    }

    function writeView(view) {
      try {
        window.localStorage.setItem(VIEW_KEY, JSON.stringify(view))
      } catch (error) {
        /* a blocked storage is not worth a broken tree */
      }
    }

    function sessionTitle(summary) {
      const title = summary !== null && typeof summary === 'object' && typeof summary.title === 'string'
        ? summary.title.trim()
        : ''
      return title === '' ? t('title.untitled') : title
    }

    function sessionTime(summary, now) {
      const stamp = summary !== null && typeof summary === 'object' ? summary.updatedAt : undefined
      const time = typeof stamp === 'number' ? stamp : Date.parse(stamp)
      if (!Number.isFinite(time)) return ''
      const delta = now - time
      if (!Number.isFinite(delta) || delta < 60_000) return t('time.now')
      if (delta < 3_600_000) return t('time.minutes', { count: Math.floor(delta / 60_000) })
      if (delta < 86_400_000) return t('time.hours', { count: Math.floor(delta / 3_600_000) })
      return t('time.days', { count: Math.floor(delta / 86_400_000) })
    }

    /* --------------------------------------------------------------------- icons */

    function Chevron(props) {
      return h('svg', {
        className: 'sg-chevron' + (props.open === true ? ' sg-chevron-open' : ''),
        viewBox: '0 0 12 12',
        width: 12,
        height: 12,
        'aria-hidden': 'true',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
      }, h('path', { d: 'M4.5 2.5 8 6l-3.5 3.5' }))
    }

    function PlusIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }, h('path', { d: 'M8 3.5v9M3.5 8h9' }))
    }

    function SearchIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }, h('circle', { cx: 7, cy: 7, r: 4.2 }), h('path', { d: 'm10.2 10.2 3 3' }))
    }

    function DotsIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', fill: 'currentColor',
      },
        h('circle', { cx: 3.5, cy: 8, r: 1.2 }),
        h('circle', { cx: 8, cy: 8, r: 1.2 }),
        h('circle', { cx: 12.5, cy: 8, r: 1.2 }),
      )
    }

    function SessionIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }, h('path', { d: 'M3 4h10M3 8h10M3 12h6' }))
    }

    function FolderIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
      }, h('path', { d: 'M2.5 4.5h4l1.3 1.6h5.7v6.4h-11z' }))
    }

    /* ------------------------------------------------------------- error boundary */

    /**
     * Replacing the official session region means a render failure would blank
     * the whole left column. Catch it and draw the official component instead.
     */
    class SidebarFallback extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.warn('[dsh-grouped-sessions] sidebar render failed, falling back to the official list', error)
      }

      render() {
        if (this.state.failed) {
          const Official = this.props.official
          return Official === undefined || Official === null ? null : h(Official, this.props.hostProps)
        }
        return this.props.children
      }
    }

    /* ---------------------------------------------------------------- the region */

    const EMPTY_WORKSPACES = { items: [], archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'ready' }
    const EMPTY_SESSIONS = { ids: [], byId: {}, current: null, phase: 'ready', projectionsBySession: {} }

    function readSnapshot(hook, fallback) {
      if (typeof hook !== 'function') return fallback
      try {
        const value = hook(state => state)
        return value === undefined || value === null ? fallback : value
      } catch (error) {
        console.warn('[dsh-grouped-sessions] snapshot read failed:', error)
        return fallback
      }
    }

    /** The workspace → group → session tree that replaces the official region. */
    function GroupsSidebar(props) {
      useLocaleRevision()
      const workspacesSnapshot = readSnapshot(props.useWorkspaces, EMPTY_WORKSPACES)
      const sessionsSnapshot = readSnapshot(props.useSessions, EMPTY_SESSIONS)

      const actions = props.actions !== null && typeof props.actions === 'object' ? props.actions : {}

      const [groups, setGroups] = React.useState([])
      const [loadError, setLoadError] = React.useState(null)
      const [saveError, setSaveError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [now, setNow] = React.useState(() => Date.now())
      const [view, setView] = React.useState(readView)
      const [openMenu, setOpenMenu] = React.useState(null)
      const [creatingFor, setCreatingFor] = React.useState(null)
      const [draftName, setDraftName] = React.useState('')
      const [renamingId, setRenamingId] = React.useState(null)
      const [renameDraft, setRenameDraft] = React.useState('')
      const [dropTarget, setDropTarget] = React.useState(null)
      const [draggingId, setDraggingId] = React.useState(null)
      const [searchOpen, setSearchOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [formError, setFormError] = React.useState(null)
      const [failedPayload, setFailedPayload] = React.useState(null)

      const reload = React.useCallback(async () => {
        try {
          const next = await loadGroups()
          setGroups(next)
          setLoadError(null)
        } catch (error) {
          console.warn('[dsh-grouped-sessions] load failed:', error)
          setLoadError(t('error.load'))
        }
      }, [])

      React.useEffect(() => {
        void reload()
      }, [reload])

      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60_000)
        return () => window.clearInterval(timer)
      }, [])

      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        /* A press inside an open menu must not close it before its click fires. */
        const onPointerDown = event => {
          const target = event.target
          if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('.sg-menu') !== null) {
            return
          }
          setOpenMenu(null)
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => document.removeEventListener('pointerdown', onPointerDown)
      }, [])

      React.useEffect(() => {
        writeView(view)
      }, [view])

      /* Move focus into a freshly opened menu so its own key handling works. */
      React.useEffect(() => {
        if (openMenu === null || typeof document === 'undefined') return
        const menu = document.querySelector('.sg-menu')
        if (menu === null) return
        const first = menu.querySelector('.sg-menu-item:not([disabled])')
        if (first !== null && typeof first.focus === 'function') first.focus()
      }, [openMenu])

      const run = React.useCallback(async payload => {
        setBusy(true)
        setSaveError(null)
        try {
          const next = await mutateGroups(payload)
          setGroups(next)
          setFailedPayload(null)
          return true
        } catch (error) {
          setSaveError(errorText(error))
          /* Keep the rejected change so "Retry" can replay exactly it. */
          setFailedPayload(payload)
          return false
        } finally {
          setBusy(false)
        }
      }, [])

      const workspaces = Array.isArray(workspacesSnapshot.items) ? workspacesSnapshot.items : []
      const archived = Array.isArray(workspacesSnapshot.archivedSessionIds) ? workspacesSnapshot.archivedSessionIds : []
      const archivedSet = React.useMemo(() => new Set(archived.map(String)), [archived])
      const byId = sessionsSnapshot.byId !== null && typeof sessionsSnapshot.byId === 'object' ? sessionsSnapshot.byId : {}
      const currentId = typeof sessionsSnapshot.current === 'string' ? sessionsSnapshot.current : null

      /* Drop remembered expansion of groups/workspaces that no longer exist. */
      React.useEffect(() => {
        const liveGroups = new Set(groups.map(group => group.id))
        const liveWorkspaces = new Set(workspaces.map(workspace => workspace.workspaceId))
        setView(previous => {
          const groupsNext = previous.expandedGroups.filter(id => liveGroups.has(id))
          const workspacesNext = previous.collapsedWorkspaces.filter(id => liveWorkspaces.has(id))
          const ungroupedNext = previous.collapsedUngrouped.filter(id => liveWorkspaces.has(id.slice(UNGROUPED_PREFIX.length)))
          const orderNext = {}
          let droppedOrder = false
          for (const [workspaceId, value] of Object.entries(previous.ungroupedOrder)) {
            if (liveWorkspaces.has(workspaceId)) orderNext[workspaceId] = value
            else droppedOrder = true
          }
          if (groupsNext.length === previous.expandedGroups.length
            && workspacesNext.length === previous.collapsedWorkspaces.length
            && ungroupedNext.length === previous.collapsedUngrouped.length
            && !droppedOrder) return previous
          return {
            ...previous,
            expandedGroups: groupsNext,
            collapsedWorkspaces: workspacesNext,
            collapsedUngrouped: ungroupedNext,
            ungroupedOrder: orderNext,
          }
        })
      }, [groups, workspaces])

      const openSession = React.useCallback(sessionId => {
        const target = typeof props.openSession === 'function'
          ? props.openSession
          : (typeof props.open === 'function' ? props.open : null)
        if (typeof target === 'function') {
          try {
            target(sessionId)
            return
          } catch (error) {
            console.warn('[dsh-grouped-sessions] host open failed:', error)
          }
        }
        if (typeof actions.open === 'function') actions.open(sessionId)
      }, [props.openSession, props.open, actions])

      /** Sessions of one workspace, in the workspace's own order, filtered for display. */
      const sessionsOfWorkspace = React.useCallback(workspace => {
        const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        const out = []
        for (const id of ids) {
          const key = String(id)
          if (archivedSet.has(key)) continue
          const summary = byId[id] !== undefined ? byId[id] : byId[key]
          if (summary !== undefined && summary !== null) {
            if (summary.origin === 'subagent') continue
            if (summary.blank === true && key !== currentId) continue
          }
          const title = sessionTitle(summary)
          if (query !== '' && !title.toLowerCase().includes(query.toLowerCase())) continue
          out.push({ id: key, workspaceId: workspace.workspaceId, summary, title })
        }
        return out
      }, [byId, archivedSet, currentId, query])

      const groupsOfWorkspace = React.useCallback(workspaceId =>
        groups
          .filter(group => group.workspaceId === workspaceId)
          .slice()
          .sort((left, right) => left.order - right.order),
      [groups])

      const assign = React.useCallback(async (sessionId, workspaceId, groupId) => {
        /* One payload shape for "remove from group": an empty groupId. */
        const target = typeof groupId === 'string' ? groupId : ''
        const ok = await run({
          action: 'assign',
          sessionId,
          workspaceId,
          groupId: target,
        })
        /* Groups start closed, so reveal the one that just received the session —
           otherwise filing looks like the row simply disappeared. */
        if (ok && target !== '') setView(previous => (previous.expandedGroups.includes(target)
          ? previous
          : { ...previous, expandedGroups: previous.expandedGroups.concat(target) }))
        return ok
      }, [run])

      const createGroup = React.useCallback(async workspaceId => {
        const name = draftName.trim()
        if (name === '') {
          setFormError(t('error.missing-name'))
          return false
        }
        setFormError(null)
        const ok = await run({ action: 'create', workspaceId, name })
        if (ok) {
          setCreatingFor(null)
          setDraftName('')
        }
        return ok
      }, [draftName, run])

      const commitRename = React.useCallback(async groupId => {
        const name = renameDraft.trim()
        /* Validate before closing: otherwise a typo silently discards the text. */
        if (name === '') {
          setFormError(t('error.missing-name'))
          return false
        }
        setRenamingId(null)
        setFormError(null)
        return run({ action: 'rename', groupId, name })
      }, [renameDraft, run])

      const deleteGroup = React.useCallback(async group => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(t('confirm.delete', { name: group.name }))) return false
        return run({ action: 'delete', groupId: group.id })
      }, [run])

      const toggleWorkspace = workspaceId => setView(previous => ({
        ...previous,
        collapsedWorkspaces: previous.collapsedWorkspaces.includes(workspaceId)
          ? previous.collapsedWorkspaces.filter(id => id !== workspaceId)
          : previous.collapsedWorkspaces.concat(workspaceId),
      }))

      const toggleGroup = groupId => setView(previous => ({
        ...previous,
        expandedGroups: previous.expandedGroups.includes(groupId)
          ? previous.expandedGroups.filter(id => id !== groupId)
          : previous.expandedGroups.concat(groupId),
      }))

      /** Move one group one step up or down among its workspace's groups. */
      const moveGroup = React.useCallback(async (groupId, direction) => {
        setOpenMenu(null)
        return run({ action: 'move', groupId, direction })
      }, [run])

      /**
       * Move the `ungrouped` bucket one slot among its workspace's groups.
       *
       * The bucket is derived from sessions rather than stored, so it has no
       * `order` of its own; its slot is the number of groups shown above it,
       * kept in the view state (it is a way of looking at the list, not data).
       */
      const moveUngrouped = (workspaceId, direction, index, count) => {
        const next = direction === 'up' ? index - 1 : index + 1
        if (next < 0 || next > count) {
          setOpenMenu(null)
          return
        }
        setOpenMenu(null)
        setView(previous => ({
          ...previous,
          ungroupedOrder: { ...previous.ungroupedOrder, [workspaceId]: next },
        }))
      }

      /* ---------------------------------------------------------- drag and drop */

      const dragStart = (event, sessionId) => {
        setDraggingId(sessionId)
        try {
          event.dataTransfer.setData('application/x-dsh-session-id', sessionId)
          event.dataTransfer.effectAllowed = 'move'
        } catch (error) {
          /* some environments expose no dataTransfer on synthetic events */
        }
      }

      const dragEnd = () => {
        setDraggingId(null)
        setDropTarget(null)
      }

      /** True when the pointer is leaving `element` for real (not moving into a child). */
      const leftElement = (event, element) => {
        const next = event.relatedTarget
        return next === null || next === undefined
          || (typeof element.contains === 'function' && !element.contains(next))
      }

      /** Keyboard behaviour for an open menu: Escape closes, Up/Down walk the items. */
      const menuKeyDown = event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setOpenMenu(null)
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const container = event.currentTarget
        if (container === null || container === undefined || typeof container.querySelectorAll !== 'function') return
        const items = Array.prototype.slice.call(container.querySelectorAll('.sg-menu-item:not([disabled])'))
        if (items.length === 0) return
        event.preventDefault()
        const index = items.indexOf(event.target)
        const next = event.key === 'ArrowDown'
          ? items[(index + 1) % items.length]
          : items[(index - 1 + items.length) % items.length]
        if (next !== undefined && typeof next.focus === 'function') next.focus()
      }

      const dropOn = async (event, workspaceId, groupId) => {
        event.preventDefault()
        const sessionId = carriesSessionId(event) ? readDraggedId(event) : null
        const effective = sessionId ?? draggingId
        setDropTarget(null)
        setDraggingId(null)
        if (effective === null || effective === undefined) return
        await assign(String(effective), workspaceId, groupId)
      }

      /* ------------------------------------------------------------- rendering */

      const activeWorkspaceId = currentWorkspaceId(workspaces, currentId)
      const filtered = query !== ''
      const noMatches = filtered && workspaces.every(workspace => sessionsOfWorkspace(workspace).length === 0)

      const renderMenu = (row, groupId) => {
        const menuId = row.id
        if (openMenu !== menuId) return null
        const workspaceId = row.workspaceId
        const workspaceGroups = groupsOfWorkspace(workspaceId)
        return h('div', {
          className: 'sg-menu',
          role: 'menu',
          'aria-label': t('tree.sessionMenu'),
          onKeyDown: menuKeyDown,
        },
          h('div', { className: 'sg-menu-label' }, t('tree.moveTo')),
          workspaceGroups.length === 0
            ? h('div', { className: 'sg-menu-label' }, t('tree.noGroup'))
            : workspaceGroups.map(group => h('button', {
                key: group.id,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': groupId === group.id,
                className: 'sg-menu-item',
                disabled: busy,
                onClick: event => {
                  event.stopPropagation()
                  setOpenMenu(null)
                  if (groupId !== group.id) void assign(row.id, workspaceId, group.id)
                },
              },
                h('span', { className: 'sg-check', 'aria-hidden': 'true' }, groupId === group.id ? '✓' : ''),
                h('span', { className: 'sg-group-name' }, group.name),
              )),
          groupId === null
            ? null
            : h('button', {
                type: 'button',
                role: 'menuitem',
                className: 'sg-menu-item',
                disabled: busy,
                onClick: event => {
                  event.stopPropagation()
                  setOpenMenu(null)
                  void assign(row.id, workspaceId, null)
                },
              },
                h('span', { className: 'sg-check', 'aria-hidden': 'true' }),
                h('span', null, t('tree.moveOut')),
              ),
        )
      }

      const renderRow = (row, groupId) => {
        const isCurrent = row.id === currentId
        const running = row.summary !== null && row.summary !== undefined && row.summary.running === true
        return h('div', { key: groupId + ':' + row.id, className: 'sg-menu-wrap' },
          h('div', { className: 'sg-row' + (isCurrent ? ' sg-row-current' : ''), 'data-session-id': row.id },
            h('button', {
              type: 'button',
              className: 'sg-row-hit',
              draggable: true,
              title: row.title,
              onClick: () => openSession(row.id),
              onDragStart: event => dragStart(event, row.id),
              onDragEnd: dragEnd,
            },
              h('span', { className: 'sg-dot' + (running ? ' sg-dot-running' : ''), 'aria-hidden': 'true' }),
              h('span', { className: 'sg-row-title' }, row.title),
              h('span', { className: 'sg-row-time' }, sessionTime(row.summary, now)),
            ),
            h('button', {
              type: 'button',
              className: 'sg-icon-btn',
              'aria-haspopup': 'true',
              'aria-expanded': openMenu === row.id,
              'aria-label': t('tree.sessionMenu'),
              title: t('tree.sessionMenu'),
              onPointerDown: event => event.stopPropagation(),
              onClick: event => {
                event.stopPropagation()
                setOpenMenu(previous => (previous === row.id ? null : row.id))
              },
            }, DotsIcon()),
          ),
          renderMenu(row, groupId),
        )
      }

      const renderGroup = (workspaceId, group, workspaceRows, siblings) => {
        const rows = sessionsOfWorkspaceByGroup(workspaceRows, group)
        const collapsed = !view.expandedGroups.includes(group.id)
        const position = siblings.findIndex(item => item.id === group.id)
        const canMoveUp = position > 0
        const canMoveDown = position >= 0 && position < siblings.length - 1
        const isDrop = dropTarget === group.id
        return h('div', {
          key: group.id,
          className: 'sg-group' + (isDrop ? ' sg-group-drop' : ''),
          onDragOver: event => {
            if (!carriesSessionId(event)) return
            event.preventDefault()
            setDropTarget(group.id)
            setDraggingId(previous => previous !== null ? previous : 'dragging')
          },
          onDragLeave: event => {
            if (leftElement(event, event.currentTarget)) {
              setDropTarget(previous => (previous === group.id ? null : previous))
            }
          },
          onDrop: event => void dropOn(event, workspaceId, group.id),
        },
          renamingId === group.id
            ? h('div', { className: 'sg-inline-form' },
                h('input', {
                  className: 'sg-input',
                  autoFocus: true,
                  value: renameDraft,
                  'aria-label': t('prompt.groupName'),
                  onChange: event => setRenameDraft(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter') void commitRename(group.id)
                    if (event.key === 'Escape') { setRenamingId(null); setFormError(null) }
                  },
                }),
                h('div', { className: 'sg-form-actions' },
                  h('button', { type: 'button', className: 'sg-btn sg-btn-ghost', onClick: () => { setRenamingId(null); setFormError(null) } }, t('action.cancel')),
                  h('button', { type: 'button', className: 'sg-btn sg-btn-primary', disabled: busy, onClick: () => void commitRename(group.id) }, t('action.save')),
                ),
                formError !== null ? h('div', { className: 'sg-error-text sg-form-error' }, formError) : null,
              )
            : h('div', { className: 'sg-menu-wrap' },
                // The row is a button; the menu trigger is its sibling, never a
                // nested interactive element (a button inside a button is invalid).
                h('div', { className: 'sg-group-main' },
                  h('button', {
                    type: 'button',
                    className: 'sg-group-row',
                    'aria-expanded': !collapsed,
                    'aria-label': t('tree.toggleGroup', { name: group.name }),
                    onClick: () => toggleGroup(group.id),
                  },
                    h(Chevron, { open: !collapsed }),
                    h('span', { className: 'sg-group-name', title: group.name }, group.name),
                    h('span', { className: 'sg-group-count' }, String(rows.length)),
                  ),
                  h('button', {
                    type: 'button',
                    className: 'sg-icon-btn',
                    'aria-label': t('tree.groupMenu'),
                    title: t('tree.groupMenu'),
                    'aria-haspopup': 'true',
                    'aria-expanded': openMenu === 'group:' + group.id,
                    onPointerDown: event => event.stopPropagation(),
                    onClick: event => {
                      event.stopPropagation()
                      const key = 'group:' + group.id
                      setOpenMenu(previous => (previous === key ? null : key))
                    },
                  }, DotsIcon()),
                ),
                openMenu === 'group:' + group.id
                  ? h('div', { className: 'sg-menu', role: 'menu', 'aria-label': t('tree.groupMenu'), onKeyDown: menuKeyDown },
                      h('button', {
                        type: 'button',
                        role: 'menuitem',
                        className: 'sg-menu-item',
                        disabled: busy || !canMoveUp,
                        onClick: event => {
                          event.stopPropagation()
                          void moveGroup(group.id, 'up')
                        },
                      }, h('span', { className: 'sg-check', 'aria-hidden': 'true' }), h('span', null, t('tree.moveUp'))),
                      h('button', {
                        type: 'button',
                        role: 'menuitem',
                        className: 'sg-menu-item',
                        disabled: busy || !canMoveDown,
                        onClick: event => {
                          event.stopPropagation()
                          void moveGroup(group.id, 'down')
                        },
                      }, h('span', { className: 'sg-check', 'aria-hidden': 'true' }), h('span', null, t('tree.moveDown'))),
                      h('button', {
                        type: 'button',
                        role: 'menuitem',
                        className: 'sg-menu-item',
                        disabled: busy,
                        onClick: event => {
                          event.stopPropagation()
                          setOpenMenu(null)
                          setRenamingId(group.id)
                          setRenameDraft(group.name)
                          setFormError(null)
                        },
                      }, h('span', { className: 'sg-check', 'aria-hidden': 'true' }), h('span', null, t('tree.renameGroup'))),
                      h('button', {
                        type: 'button',
                        role: 'menuitem',
                        className: 'sg-menu-item sg-menu-item-danger',
                        disabled: busy,
                        onClick: event => {
                          event.stopPropagation()
                          setOpenMenu(null)
                          void deleteGroup(group)
                        },
                      }, h('span', { className: 'sg-check', 'aria-hidden': 'true' }), h('span', null, t('tree.deleteGroup'))),
                    )
                  : null,
              ),
          isDrop ? h('div', { className: 'sg-hint' }, t('tree.dropGroup')) : null,          collapsed ? null : h('div', { className: 'sg-rows' },
            rows.length === 0
              ? (filtered ? null : h('div', { className: 'sg-empty' }, t('tree.empty')))
              : rows.map(row => renderRow(row, group.id)),
          ),
        )
      }

      const renderUngrouped = (workspace, ungroupedRows, position, groupCount) => {
        const groupKey = UNGROUPED_PREFIX + workspace.workspaceId
        const isDrop = dropTarget === groupKey
        /* The bucket is where unfiled sessions live, so it starts open while
           groups the user created start closed. */
        const collapsed = view.collapsedUngrouped.includes(groupKey)
        const menuKey = 'ungrouped:' + workspace.workspaceId
        const canMoveUp = position > 0
        const canMoveDown = position < groupCount
        return h('div', {
          key: groupKey,
          className: 'sg-group' + (isDrop ? ' sg-group-drop' : ''),
          onDragOver: event => {
            if (!carriesSessionId(event)) return
            event.preventDefault()
            setDropTarget(groupKey)
            setDraggingId(previous => previous !== null ? previous : 'dragging')
          },
          onDragLeave: event => {
            if (leftElement(event, event.currentTarget)) {
              setDropTarget(previous => (previous === groupKey ? null : previous))
            }
          },
          onDrop: event => void dropOn(event, workspace.workspaceId, ''),
        },
          h('div', { className: 'sg-menu-wrap' },
            h('div', { className: 'sg-group-main' },
              h('button', {
                type: 'button',
                className: 'sg-group-row',
                'aria-expanded': !collapsed,
                'aria-label': t('tree.toggleGroup', { name: t('tree.ungrouped') }),
                onClick: () => setView(previous => ({
                  ...previous,
                  collapsedUngrouped: previous.collapsedUngrouped.includes(groupKey)
                    ? previous.collapsedUngrouped.filter(id => id !== groupKey)
                    : previous.collapsedUngrouped.concat(groupKey),
                })),
              },
                h(Chevron, { open: !collapsed }),
                h('span', { className: 'sg-group-name' }, t('tree.ungrouped')),
                h('span', { className: 'sg-group-count' }, String(ungroupedRows.length)),
              ),
              h('button', {
                type: 'button',
                className: 'sg-icon-btn',
                'aria-label': t('tree.ungroupedMenu'),
                title: t('tree.ungroupedMenu'),
                'aria-haspopup': 'true',
                'aria-expanded': openMenu === menuKey,
                onPointerDown: event => event.stopPropagation(),
                onClick: event => {
                  event.stopPropagation()
                  setOpenMenu(previous => (previous === menuKey ? null : menuKey))
                },
              }, DotsIcon()),
            ),
            openMenu === menuKey
              ? h('div', { className: 'sg-menu', role: 'menu', 'aria-label': t('tree.ungroupedMenu'), onKeyDown: menuKeyDown },
                  h('button', {
                    type: 'button',
                    role: 'menuitem',
                    className: 'sg-menu-item',
                    disabled: !canMoveUp,
                    onClick: event => {
                      event.stopPropagation()
                      moveUngrouped(workspace.workspaceId, 'up', position, groupCount)
                    },
                  }, h('span', { className: 'sg-check', 'aria-hidden': 'true' }), h('span', null, t('tree.moveUp'))),
                  h('button', {
                    type: 'button',
                    role: 'menuitem',
                    className: 'sg-menu-item',
                    disabled: !canMoveDown,
                    onClick: event => {
                      event.stopPropagation()
                      moveUngrouped(workspace.workspaceId, 'down', position, groupCount)
                    },
                  }, h('span', { className: 'sg-check', 'aria-hidden': 'true' }), h('span', null, t('tree.moveDown'))),
                )
              : null,
          ),
          collapsed ? null : h('div', { className: 'sg-rows' },
            ungroupedRows.length === 0
              ? (filtered ? null : h('div', { className: 'sg-empty' }, t('tree.empty')))
              : ungroupedRows.map(row => renderRow(row, null)),
          ),
          isDrop ? h('div', { className: 'sg-hint' }, t('tree.dropUngrouped')) : null,
        )
      }

      const renderWorkspace = workspace => {
        const title = typeof workspace.title === 'string' && workspace.title.trim() !== ''
          ? workspace.title.trim()
          : t('title.defaultName')
        const collapsed = view.collapsedWorkspaces.includes(workspace.workspaceId)
        const rows = sessionsOfWorkspace(workspace)
        const workspaceGroups = groupsOfWorkspace(workspace.workspaceId)
        const filed = new Set(rows.map(row => row.id))
        for (const group of workspaceGroups) {
          const members = Array.isArray(group.sessionIds) ? group.sessionIds : []
          for (const id of members) filed.delete(String(id))
        }
        const ungroupedRows = rows.filter(row => filed.has(row.id))
        /* Where the bucket sits among the groups: a stored slot, clamped so a
           group being deleted elsewhere can never push it out of the list. */
        const storedPosition = view.ungroupedOrder[workspace.workspaceId]
        const ungroupedPosition = typeof storedPosition === 'number'
          ? Math.max(0, Math.min(workspaceGroups.length, storedPosition))
          : workspaceGroups.length
        const total = rows.length
        return h('div', { key: workspace.workspaceId, className: 'sg-ws' },
          h('div', { className: 'sg-menu-wrap' },
            h('div', { className: 'sg-ws-main' },
              h('button', {
                type: 'button',
                className: 'sg-ws-row',
                'aria-expanded': !collapsed,
                'aria-label': t('tree.toggleWorkspace', { name: title }),
                title: workspace.path,
                onClick: () => toggleWorkspace(workspace.workspaceId),
              },
                h(Chevron, { open: !collapsed }),
                h('span', { className: 'sg-ws-name' }, title),
                h('span', { className: 'sg-group-count' }, String(total)),
              ),
              h('button', {
                type: 'button',
                className: 'sg-icon-btn',
                'aria-label': t('tree.newGroup'),
                title: t('tree.newGroup'),
                onClick: () => {
                  setCreatingFor(workspace.workspaceId)
                  setDraftName('')
                  setFormError(null)
                  setOpenMenu(null)
                  /* The inline form lives inside the expanded body: open it. */
                  setView(previous => ({
                    ...previous,
                    collapsedWorkspaces: previous.collapsedWorkspaces.filter(id => id !== workspace.workspaceId),
                  }))
                },
              }, PlusIcon()),
              h('button', {
                type: 'button',
                className: 'sg-icon-btn',
                'aria-label': t('tree.newSession'),
                title: t('tree.newSession'),
                onClick: () => {
                  setSaveError(startSession(props, actions, workspace.workspaceId) ? null : t('error.failed'))
                },
              }, SessionIcon()),
            ),
          ),
          collapsed ? null : h('div', { className: 'sg-rows' },
            creatingFor === workspace.workspaceId
              ? h('div', { className: 'sg-inline-form' },
                  h('input', {
                    className: 'sg-input',
                    autoFocus: true,
                    value: draftName,
                    placeholder: t('prompt.groupName'),
                    'aria-label': t('prompt.groupName'),
                    onChange: event => setDraftName(event.target.value),
                    onKeyDown: event => {
                      if (event.key === 'Enter') void createGroup(workspace.workspaceId)
                      if (event.key === 'Escape') setCreatingFor(null)
                    },
                  }),
                  h('div', { className: 'sg-form-actions' },
                    h('button', { type: 'button', className: 'sg-btn sg-btn-ghost', onClick: () => { setCreatingFor(null); setFormError(null) } }, t('action.cancel')),
                    h('button', {
                      type: 'button',
                      className: 'sg-btn sg-btn-primary',
                      disabled: busy || draftName.trim() === '',
                      onClick: () => void createGroup(workspace.workspaceId),
                    }, t('action.save')),
                  ),
                  formError !== null ? h('div', { className: 'sg-error-text sg-form-error' }, formError) : null,
                )
              : null,
            workspaceGroups.length === 0 && creatingFor !== workspace.workspaceId
              ? h('div', { className: 'sg-empty' }, t('tree.noGroup'))
              : null,
            workspaceGroups.slice(0, ungroupedPosition).map(group => renderGroup(workspace.workspaceId, group, rows, workspaceGroups)),
            renderUngrouped(workspace, ungroupedRows, ungroupedPosition, workspaceGroups.length),
            workspaceGroups.slice(ungroupedPosition).map(group => renderGroup(workspace.workspaceId, group, rows, workspaceGroups)),
          ),
        )
      }

      const header = h('div', { className: 'sg-top' },
        h('span', { className: 'sg-top-label' }, t('tree.title')),
        h('button', {
          type: 'button',
          className: 'sg-icon-btn',
          'aria-pressed': searchOpen,
          'aria-label': t('tree.search'),
          title: t('tree.search'),
          onClick: () => {
            setSearchOpen(previous => !previous)
            setQuery('')
          },
        }, SearchIcon()),
        h('button', {
          type: 'button',
          className: 'sg-icon-btn',
          'aria-label': t('tree.newGroup'),
          title: t('tree.newGroup'),
          disabled: activeWorkspaceId === null,
          onClick: () => {
            if (activeWorkspaceId === null) return
            setCreatingFor(activeWorkspaceId)
            setDraftName('')
            setFormError(null)
            setView(previous => ({
              ...previous,
              collapsedWorkspaces: previous.collapsedWorkspaces.filter(id => id !== activeWorkspaceId),
            }))
          },
        }, PlusIcon()),
      )

      return h('div', { className: 'sg-root' },
        header,
        searchOpen
          ? h('div', { className: 'sg-search' },
              h('input', {
                className: 'sg-search-input',
                autoFocus: true,
                value: query,
                placeholder: t('tree.searchPlaceholder'),
                'aria-label': t('tree.search'),
                onChange: event => setQuery(event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Escape') {
                    setQuery('')
                    setSearchOpen(false)
                  }
                },
              }),
            )
          : null,
        loadError !== null
          ? h('div', { className: 'sg-error' },
              h('span', { className: 'sg-error-text' }, loadError),
              h('button', { type: 'button', className: 'sg-link', onClick: () => void reload() }, t('action.retry')),
            )
          : null,
        saveError !== null
          ? h('div', { className: 'sg-error' },
              h('span', { className: 'sg-error-text' }, saveError),
              failedPayload !== null && !busy
                ? h('button', { type: 'button', className: 'sg-link', onClick: () => void run(failedPayload) }, t('action.retry'))
                : null,
              h('button', { type: 'button', className: 'sg-link', onClick: () => { setSaveError(null); setFailedPayload(null) } }, t('action.cancel')),
            )
          : null,
        h('div', { className: 'sg-list' },
          workspaces.length === 0
            ? h('div', { className: 'sg-empty' }, t('tree.noWorkspace'))
            : noMatches
              ? h('div', { className: 'sg-empty' }, t('tree.noMatch'))
              : workspaces.map(renderWorkspace),
        ),
      )
    }

    /* --------------------------------------------------------------- small utils */

    /** The dragged session id, from the plugin's own typed flavour only. */
    function readDraggedId(event) {
      try {
        const typed = event.dataTransfer.getData('application/x-dsh-session-id')
        if (typeof typed === 'string' && typed !== '') return typed
      } catch (error) {
        /* dataTransfer may be absent on synthetic events */
      }
      return null
    }

    /** True when this drag carries a session id (never accepts outside text). */
    function carriesSessionId(event) {
      try {
        const types = event.dataTransfer.types
        if (types === undefined || types === null) return true
        if (typeof types.includes === 'function') return types.includes('application/x-dsh-session-id')
        if (typeof types.contains === 'function') return types.contains('application/x-dsh-session-id')
        return true
      } catch (error) {
        return true
      }
    }

    /** Workspace id owning the current session, else the first workspace. */
    function currentWorkspaceId(workspaces, currentId) {
      if (currentId !== null) {
        for (const workspace of workspaces) {
          const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
          if (ids.some(id => String(id) === currentId)) return workspace.workspaceId
        }
      }
      return workspaces.length === 0 ? null : workspaces[0].workspaceId
    }

    /** Rows of one group, keeping the workspace order. */
    function sessionsOfWorkspaceByGroup(rows, group) {
      const members = new Set((Array.isArray(group.sessionIds) ? group.sessionIds : []).map(String))
      return rows.filter(row => members.has(row.id))
    }

    /** Start a session in one workspace (official New-session behaviour). */
    function startSession(props, actions, workspaceId) {
      const start = typeof props.startSession === 'function'
        ? props.startSession
        : (typeof actions.startSession === 'function' ? actions.startSession : null)
      if (start !== null) {
        try {
          start(workspaceId)
          return true
        } catch (error) {
          console.warn('[dsh-grouped-sessions] startSession failed:', error)
        }
      }
      if (typeof props.openWorkspace === 'function') {
        try {
          void props.openWorkspace(workspaceId)
          return true
        } catch (error) {
          console.warn('[dsh-grouped-sessions] openWorkspace failed:', error)
        }
      }
      console.warn('[dsh-grouped-sessions] this shell exposes no way to start a session')
      return false
    }

    /* -------------------------------------------------------------------- plugin */

    function setupLocale(ctx) {
      /** Everything the retry loop may have installed, torn down on dispose. */
      const disposers = []
      let stopped = false

      const disposeAll = () => {
        stopped = true
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch (error) {
            /* locale teardown must never throw */
          }
        }
        disposers.length = 0
      }

      /**
       * Register the dictionaries and bind `translate`.
       *
       * The locale service is provided by another bundle, and this plugin's
       * client bundle may evaluate before it exists (it is injected with
       * `immediately`), so a missing service is retried rather than treated as
       * "no localization" — that fallback used to hard-wire English.
       */
      const attempt = () => {
        let locale
        try {
          locale = ctx.get('locale')
        } catch (error) {
          locale = undefined
        }
        if (locale === undefined || typeof locale.register !== 'function') return false

        try {
          disposers.push(locale.register(NS, 'en', EN))
          disposers.push(locale.register(NS, 'zh', ZH))
        } catch (error) {
          console.warn('[dsh-grouped-sessions] locale dictionaries already registered:', error)
        }

        bindLocale(locale)

        if (typeof locale.subscribe === 'function') {
          const unsubscribe = locale.subscribe(() => {
            bindLocale(locale)
          })
          if (typeof unsubscribe === 'function') disposers.push(unsubscribe)
        }
        return true
      }

      if (attempt()) return disposeAll

      /**
       * Retry budget: a fast burst (~10 s) for the usual load-order race, then a
       * slow keep-alive. Never stop for good: a late locale registration must
       * still switch the tree to the shell language.
       */
      let tries = 0
      let warned = false
      const timer = window.setInterval(() => {
        if (stopped) {
          window.clearInterval(timer)
          return
        }
        if (attempt()) {
          window.clearInterval(timer)
          return
        }
        tries += 1
        if (tries === 100 && !warned) {
          warned = true
          console.warn('[dsh-grouped-sessions] locale service still unavailable; keeping the English dictionary for now')
        }
      }, 100)
      disposers.push(() => window.clearInterval(timer))

      return disposeAll
    }

    /**
     * Take over the workspace/session region by swapping the occupant's
     * component, keeping the official one as the boundary's fallback.
     */
    function installSidebarTakeover(ctx) {
      const readEntries = () => {
        const read = ctx.slots.entriesOfSlot || ctx.slots.entries
        if (typeof read !== 'function') return []
        const entries = read.call(ctx.slots, 'sidebar.workspaces')
        return Array.isArray(entries) ? entries : []
      }

      let entry = null
      let original = null
      let wrapper = null

      const isWrapped = component => component !== undefined && component !== null
        && (component.__dshSessionGroupsWrapped === true || component.__dshSessionGroupsOriginal !== undefined)

      const restore = () => {
        if (entry !== null && original !== null && entry.component === wrapper) entry.component = original
        entry = null
        original = null
        wrapper = null
      }

      const syncInner = () => {
        const occupant = readEntries().find(item => item !== null && typeof item === 'object' && typeof item.component === 'function')
        if (occupant === undefined) {
          restore()
          return
        }
        if (occupant.component === wrapper) return
        if (isWrapped(occupant.component)) return
        const official = occupant.component
        entry = occupant
        original = official

        const Shell = function SessionGroupsSidebar(innerProps) {
          /* A collapsed sidebar keeps the shell's own compact rail: replacing it
             with nothing would remove session browsing entirely. */
          if (innerProps !== null && innerProps !== undefined && innerProps.wide === false) {
            return h(official, innerProps)
          }
          return h(SidebarFallback, { official: official, hostProps: innerProps },
            h(GroupsSidebar, innerProps))
        }
        Shell.displayName = 'SessionGroupsSidebar'
        Shell.__dshSessionGroupsWrapped = true
        Shell.__dshSessionGroupsOriginal = official
        wrapper = Shell
        occupant.component = Shell
        /* no self-dispatch here: the listener for this event called sync() again */
      }

      let syncing = false
      const sync = () => {
        if (syncing) return
        syncing = true
        try {
          syncInner()
        } finally {
          syncing = false
        }
      }

      sync()

      const disposers = []
      if (typeof ctx.slots.subscribe === 'function') {
        disposers.push(ctx.slots.subscribe('sidebar.workspaces', sync))
        disposers.push(ctx.slots.subscribe('sidebar', sync))
      }
      /* removed: the plugin listened to the event it dispatched, re-entering sync() */
      let retries = 0
      const timer = window.setInterval(() => {
        sync()
        if (++retries >= 20) window.clearInterval(timer)
      }, 250)
      disposers.push(() => window.clearInterval(timer))
      disposers.push(restore)
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error) {
            /* cleanup must never throw */
          }
        }
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposeLocale = setupLocale(ctx)
        const disposeStyles = ensureStyles()

        let disposeTakeover = null
        try {
          disposeTakeover = installSidebarTakeover(ctx)
        } catch (error) {
          console.warn('[dsh-grouped-sessions] sidebar takeover failed:', error)
        }

        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            if (typeof disposeTakeover === 'function') disposeTakeover()
            if (typeof disposeLocale === 'function') disposeLocale()
            disposeStyles()
          })
        }
      },
    }
  },
})
