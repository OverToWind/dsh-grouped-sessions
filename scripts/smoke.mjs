/**
 * Headless smoke test for the sidebar takeover.
 *
 * Loads `client.js` in a stub environment, applies the plugin against a mock
 * slot registry that holds one official occupant for `sidebar.workspaces`, and
 * then renders the swapped component to prove the workspace → group → session
 * tree appears and that filing a session goes out over the plugin's route.
 *
 * Run: node scripts/smoke.mjs   (from the package directory)
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/* ------------------------------------------------------------------- React stub */

const hookState = []
const hookEffects = []
let hookIndex = 0

const React = {
  createElement: (type, props, ...children) => ({
    type,
    // React exposes children on props; boundary components rely on that.
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    children,
  }),
  useState(initial) {
    const slot = hookIndex++
    if (!(slot in hookState)) hookState[slot] = typeof initial === 'function' ? initial() : initial
    return [hookState[slot], next => {
      hookState[slot] = typeof next === 'function' ? next(hookState[slot]) : next
    }]
  },
  useMemo(fn) {
    hookIndex++
    return fn()
  },
  useCallback(fn) {
    hookIndex++
    return fn
  },
  useEffect(fn) {
    hookIndex++
    hookEffects.push(fn)
  },
  useRef(value) {
    hookIndex++
    return { current: value }
  },
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...next }
    }
  },
}

/* ----------------------------------------------------------------- window stub */

const listeners = new Map()

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
  localStorage: {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null
    },
    setItem(key, value) {
      this.store.set(key, value)
    },
  },
  setInterval: () => 0,
  clearInterval: () => {},
  confirm: () => true,
  addEventListener(name, fn) {
    const list = listeners.get(name) ?? []
    listeners.set(name, list.concat(fn))
  },
  removeEventListener(name, fn) {
    listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn))
  },
  dispatchEvent(event) {
    for (const fn of listeners.get(event.type) ?? []) fn(event)
    return true
  },
}

globalThis.document = undefined

let captured = null

/* ---------------------------------------------------------------- locale stub */

const DICTS = new Map()
const EN = {}
const ZH = {}

const mockCtx = {
  get(name) {
    if (name === 'locale') {
      return {
        register(ns, lang, dict) {
          DICTS.set(lang, dict)
          Object.assign(lang === 'zh' ? ZH : EN, dict)
          return () => {}
        },
        bind(ns) {
          return key => (DICTS.get('en')?.[key] ?? key)
        },
      }
    }
    return undefined
  },
  slots: {
    entriesOfSlot(slot) {
      if (slot !== 'sidebar.workspaces') return []
      return [officialOccupant]
    },
    subscribe() {
      return () => {}
    },
  },
  effect(fn) {
    disposers.push(fn())
  },
}

const disposers = []

/** The shipped region, as the shell would hand it to us. */
function OfficialBrowser() {
  return { type: 'div', props: { className: 'official' }, children: ['official list'] }
}
const officialOccupant = { name: 'sidebar.workspaces', component: OfficialBrowser }

/* ----------------------------------------------------------------- load plugin */

new Function('window', 'require', source)(globalThis.window, () => React)
if (captured === null) throw new Error('factory never registered')
if (captured.id !== 'dsh-grouped-sessions') throw new Error('bundle id mismatch: ' + captured.id)

const plugin = captured.factory(() => React)
plugin.apply(mockCtx)

console.log('bundle id:', captured.id)
console.log('plugin inject:', JSON.stringify(plugin.inject))
console.log('locale dicts:', [...DICTS.keys()].join(','), '| keys per dict:',
  [...DICTS.entries()].map(([lang, dict]) => lang + '=' + Object.keys(dict).length).join(' '))

/* --------------------------------------------------- the takeover actually happened */

const Wrapper = officialOccupant.component
if (Wrapper === OfficialBrowser) throw new Error('official occupant was not replaced')
if (Wrapper.__dshSessionGroupsWrapped !== true) throw new Error('wrapper flag missing')
if (Wrapper.__dshSessionGroupsOriginal !== OfficialBrowser) throw new Error('official component not remembered')
console.log('takeover: occupant component swapped, official kept as fallback')

/* --------------------------------------------------------------- snapshots and fetch */

const now = Date.now()
const workspaceSnapshot = {
  items: [
    { workspaceId: 'ws-1', path: 'F:/a', title: 'Alpha', sessionIds: ['s1', 's2', 's3'], createdAt: 0, updatedAt: 0 },
    { workspaceId: 'ws-2', path: 'F:/b', title: 'Beta', sessionIds: ['s4'], createdAt: 0, updatedAt: 0 },
  ],
  phase: 'ready',
  state: 'ready',
  archivedSessionIds: ['s3'],
  pinnedSessionIds: [],
}
const sessionSnapshot = {
  ids: ['s1', 's2', 's3', 's4'],
  current: 's1',
  phase: 'ready',
  byId: {
    s1: { id: 's1', title: 'First session', blank: false, running: true, updatedAt: now - 5_000 },
    s2: { id: 's2', title: 'Second session', blank: false, running: false, updatedAt: now - 3_700_000 },
    s3: { id: 's3', title: 'Archived one', blank: false, running: false, updatedAt: 0 },
    s4: { id: 's4', title: 'Other workspace', blank: false, running: false, updatedAt: now },
  },
}

let stubbedGroups = [
  { id: 'g1', workspaceId: 'ws-1', name: 'Release prep', order: 0, sessionIds: ['s2'] },
]
const calls = []

globalThis.fetch = async (url, init) => {
  const body = init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ url, body })
  if (body !== undefined) {
    if (body.action === 'assign') {
      stubbedGroups = stubbedGroups.map(group => {
        const kept = group.sessionIds.filter(id => id !== body.sessionId)
        return { ...group, sessionIds: group.id === body.groupId ? kept.concat(body.sessionId) : kept }
      })
    }
    if (body.action === 'create') {
      stubbedGroups = stubbedGroups.concat([{
        id: 'g2', workspaceId: body.workspaceId, name: body.name, order: 1, sessionIds: [],
      }])
    }
  }
  return { ok: true, json: async () => ({ groups: stubbedGroups }) }
}

/* --------------------------------------------------------------------- render */

const useWorkspaces = selector => selector(workspaceSnapshot)
const useSessions = selector => selector(sessionSnapshot)

const props = {
  wide: true,
  useWorkspaces,
  useSessions,
  openSession: id => calls.push({ open: id }),
  startSession: id => calls.push({ start: id }),
}

/**
 * The swapped component is `h(SidebarFallback, …)`, a class element. The stub
 * renderer does not instantiate classes, so mount the boundary by hand.
 */
function mount(element) {
  let node = element
  for (let guard = 0; guard < 8; guard += 1) {
    if (Array.isArray(node) && node.length === 1) {
      node = node[0]
      continue
    }
    if (node === null || typeof node !== 'object' || typeof node.type !== 'function') return node
    if (node.type.prototype instanceof React.Component) {
      const instance = new node.type(node.props)
      instance.props = node.props
      instance.state = instance.state ?? {}
      node = instance.render()
      continue
    }
    node = node.type(node.props)
  }
  return node
}

/** Render the swapped component, running effects and their follow-up renders. */
async function settle(times = 4) {
  hookIndex = 0
  hookState.length = 0
  hookEffects.length = 0
  let tree = mount(Wrapper(props))
  for (let round = 0; round < times; round += 1) {
    hookIndex = 0
    const effects = hookEffects.splice(0)
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') disposers.push(cleanup)
    }
    await Promise.allSettled([])
    await new Promise(resolve => setImmediate(resolve))
    hookIndex = 0
    tree = mount(Wrapper(props))
  }
  return tree
}

/** Keep hook state across a re-render (for interactions that set state). */
function rerender() {
  hookIndex = 0
  return mount(Wrapper(props))
}

/**
 * Let an interaction's async work and its resulting effects land without
 * throwing away hook state — `settle` re-mounts from scratch, which is right for
 * data that comes back over the route and wrong for state a click just set.
 */
async function flush() {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  hookIndex = 0
  const effects = hookEffects.splice(0)
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') disposers.push(cleanup)
  }
  return rerender()
}

function find(node, predicate) {
  if (node === null || node === undefined || node === false) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (predicate(node)) return node
  return find(node.children, predicate)
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

function textOf(node) {
  const out = []
  const walk = value => {
    if (value === null || value === undefined || value === false) return
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (typeof value === 'object') walk(value.children)
  }
  walk(node)
  return out
}

const hasClass = name => node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name)

let tree = await settle()
console.log('renders:', tree.type, '(sg-root:', find(tree, hasClass('sg-root')) !== undefined, ')')

const workspaceNames = findAll(tree, hasClass('sg-ws-name')).map(node => textOf(node).join(''))
console.log('workspaces:', JSON.stringify(workspaceNames))
if (workspaceNames.length !== 2) throw new Error('expected both workspaces')

const groupNames = findAll(tree, hasClass('sg-group-name')).map(node => textOf(node).join('')).filter(t => t !== '')
console.log('group names:', JSON.stringify(groupNames))
if (!groupNames.includes('Release prep')) throw new Error('group was not rendered')
if (!groupNames.includes('Ungrouped')) throw new Error('ungrouped row missing')

const rowTitles = findAll(tree, hasClass('sg-row-title')).map(node => textOf(node).join(''))
console.log('rows:', JSON.stringify(rowTitles))
if (rowTitles.includes('Archived one')) throw new Error('archived session leaked into the tree')
if (!rowTitles.includes('First session')) throw new Error('current session missing')

// Groups start closed, so ws-1 shows only its unfiled session (s1); s2 is filed
// in "Release prep" and stays hidden until that group is opened.
if (rowTitles.includes('Second session')) throw new Error('groups must start collapsed')
// ws-1: s1 unfiled (s2 hidden in the closed group, s3 archived); ws-2: s4.
if (rowTitles.length !== 2) throw new Error('expected 2 visible rows while groups are closed, got ' + rowTitles.length)

/* ---------------------------------------------------------- expanding a group */

const groupHeader = findAll(tree, node => node.type === 'button'
  && node.props?.['aria-label'] === 'Toggle group Release prep')[0]
if (groupHeader === undefined) throw new Error('group header not found')
if (groupHeader.props['aria-expanded'] !== false) throw new Error('group header should start collapsed')
groupHeader.props.onClick()
tree = rerender()

const expandedTitles = findAll(tree, hasClass('sg-row-title')).map(node => textOf(node).join(''))
console.log('rows after expanding:', JSON.stringify(expandedTitles))
if (!expandedTitles.includes('Second session')) throw new Error('expanding the group did not reveal its session')
if (expandedTitles.length !== 3) throw new Error('expected 3 visible rows after expanding, got ' + expandedTitles.length)

// Close it again: the filing test below then doubles as the auto-expand test.
findAll(tree, node => node.type === 'button' && node.props?.['aria-label'] === 'Toggle group Release prep')[0]
  .props.onClick()
tree = rerender()
if (findAll(tree, hasClass('sg-row-title')).length !== 2) throw new Error('collapsing the group again did not hide its session')

/* ------------------------------------------------------- filing through the menu */

const menuToggles = findAll(tree, node => node.type === 'button' && node.props?.['aria-haspopup'] === 'true'
  && typeof node.props?.className === 'string' && node.props.className.includes('sg-icon-btn')
  && node.props['aria-label'] === 'Session actions')
console.log('session menu toggles:', menuToggles.length)
// With both groups closed the only rows on screen are the unfiled ones.
if (menuToggles.length !== 2) throw new Error('expected one session menu per visible row')

// "Second session" is already in the group, so its menu is all-checked and
// clicking does nothing. File the ungrouped "First session" instead.
function toggleOfRow(title) {
  // Both group headers and session rows sit in .sg-menu-wrap; only session
  // wraps contain a .sg-row-hit.
  const wraps = findAll(tree, hasClass('sg-menu-wrap')).filter(node => find(node, hasClass('sg-row-hit')) !== undefined)
  const index = wraps.findIndex(node => textOf(node).join('').includes(title))
  if (index < 0) throw new Error('row not found: ' + title)
  const toggles = findAll(tree, node => node.type === 'button' && node.props?.['aria-haspopup'] === 'true'
    && node.props['aria-label'] === 'Session actions')
  if (toggles.length !== wraps.length) throw new Error('toggle/row count mismatch')
  return toggles[index]
}

const target = toggleOfRow('First session')
target.props.onClick({ stopPropagation() {} })
tree = rerender()
const radioItems = findAll(tree, node => node.props?.role === 'menuitemradio')
const radioLabels = radioItems.map(item => textOf(item).join(''))
console.log('menu targets:', JSON.stringify(radioLabels))
if (radioItems.length !== 1) throw new Error('row menu should list the one group')
if (!radioLabels[0].includes('Release prep')) throw new Error('row menu listed the wrong group')

radioItems[0].props.onClick({ stopPropagation() {} })
await new Promise(resolve => setImmediate(resolve))
const assignCall = calls.find(call => call.body?.action === 'assign')
console.log('assign payload:', JSON.stringify(assignCall?.body ?? null))
if (assignCall === undefined) throw new Error('menu did not file the session')
if (assignCall.body.sessionId !== 's1') throw new Error('menu filed the wrong session')
if (assignCall.body.groupId !== 'g1') throw new Error('menu sent the wrong group')
if (assignCall.body.workspaceId !== 'ws-1') throw new Error('menu sent the wrong workspace')

/* Filing into a closed group must reveal it, or the row just disappears. */
tree = await flush()
const afterFileTitles = findAll(tree, hasClass('sg-row-title')).map(node => textOf(node).join(''))
console.log('rows after filing:', JSON.stringify(afterFileTitles))
if (!afterFileTitles.includes('First session')) throw new Error('filing into a closed group did not reveal the moved session')
// The persisted-view effect is queued by the render that carries the new state,
// so it only runs on the next pass.
tree = await flush()
const storedView = JSON.parse(window.localStorage.store.get('dsh-session-groups.sidebar') ?? '{}')
console.log('stored expandedGroups:', JSON.stringify(storedView.expandedGroups))
if (!Array.isArray(storedView.expandedGroups) || !storedView.expandedGroups.includes('g1')) {
  throw new Error('filing did not remember the revealed group')
}
if ('collapsedGroups' in storedView) throw new Error('the old collapsedGroups field should no longer be written')

/* ------------------------------------------------------------ creating a group */

tree = await settle()
const newGroupButtons = findAll(tree, node => node.type === 'button' && node.props?.['aria-label'] === 'New group')
console.log('new group buttons:', newGroupButtons.length)
if (newGroupButtons.length < 1) throw new Error('no way to create a group')
newGroupButtons[0].props.onClick()
tree = rerender()
const form = find(tree, hasClass('sg-inline-form'))
if (form === undefined) throw new Error('create form did not open')
const input = find(form, node => node.type === 'input')
input.props.onChange({ target: { value: 'Docs' } })
tree = rerender()
const save = findAll(tree, node => node.type === 'button' && textOf(node).join('') === 'Save').pop()
if (save === undefined) throw new Error('create form has no save button')
save.props.onClick()
await new Promise(resolve => setImmediate(resolve))
const createCall = calls.find(call => call.body?.action === 'create')
console.log('create payload:', JSON.stringify(createCall?.body ?? null))
if (createCall === undefined) throw new Error('create never reached the route')
if (createCall.body.name !== 'Docs') throw new Error('create sent the wrong name')
if (createCall.body.workspaceId !== 'ws-1') throw new Error('create sent the wrong workspace')

/* ------------------------------------------------------------ reordering groups */
// Two groups now, so both buttons are live: g1 sits first, g2 last.
tree = await settle()
const groupToggles = findAll(tree, node => node.type === 'button' && node.props?.['aria-label'] === 'Group actions')
console.log('group menu toggles:', groupToggles.length)
if (groupToggles.length !== 2) throw new Error('expected one group menu per group')

groupToggles[0].props.onClick({ stopPropagation() {} })
tree = rerender()
const groupItems = findAll(tree, node => node.props?.role === 'menuitem')
const itemLabels = groupItems.map(item => textOf(item).join(''))
console.log('group menu items:', JSON.stringify(itemLabels))
const upItem = groupItems.find(item => textOf(item).join('') === 'Move up')
const downItem = groupItems.find(item => textOf(item).join('') === 'Move down')
if (upItem === undefined || downItem === undefined) throw new Error('group menu is missing the reorder actions')
if (upItem.props.disabled !== true) throw new Error('the first group cannot move up and must say so')
if (downItem.props.disabled === true) throw new Error('the first group should be able to move down')

downItem.props.onClick({ stopPropagation() {} })
await new Promise(resolve => setImmediate(resolve))
const moveCall = calls.find(call => call.body?.action === 'move')
console.log('move payload:', JSON.stringify(moveCall?.body ?? null))
if (moveCall === undefined) throw new Error('the reorder action never reached the route')
if (moveCall.body.groupId !== 'g1') throw new Error('reorder sent the wrong group')
if (moveCall.body.direction !== 'down') throw new Error('reorder sent the wrong direction')

// The last group has the mirror-image constraint.
tree = await settle()
const togglesAfter = findAll(tree, node => node.type === 'button' && node.props?.['aria-label'] === 'Group actions')
togglesAfter[togglesAfter.length - 1].props.onClick({ stopPropagation() {} })
tree = rerender()
const lastItems = findAll(tree, node => node.props?.role === 'menuitem')
const lastUp = lastItems.find(item => textOf(item).join('') === 'Move up')
const lastDown = lastItems.find(item => textOf(item).join('') === 'Move down')
if (lastDown.props.disabled !== true) throw new Error('the last group cannot move down and must say so')
if (lastUp.props.disabled === true) throw new Error('the last group should be able to move up')
findAll(tree, node => node.type === 'button' && node.props?.['aria-label'] === 'Group actions')[0]
  .props.onClick({ stopPropagation() {} })
tree = rerender()

/* -------------------------------------------------------------- opening a session */

tree = await settle()
const hit = find(tree, hasClass('sg-row-hit'))
hit.props.onClick()
console.log('open call:', JSON.stringify(calls.filter(call => call.open !== undefined).pop() ?? null))
if (calls.filter(call => call.open !== undefined).length === 0) throw new Error('row click did not open a session')

/* ------------------------------------------------------------- collapsed sidebar */

/* A collapsed sidebar must fall back to the official occupant, not blank out. */
const collapsedElement = Wrapper({ ...props, wide: false })
const collapsed = mount(collapsedElement)
const usedOfficial = collapsedElement !== null && collapsedElement !== undefined
  && collapsedElement.type === OfficialBrowser
console.log('collapsed render:', collapsed === null ? 'null' : 'official fallback => ' + String(usedOfficial))
if (collapsed === null) throw new Error('collapsed sidebar must fall back to the official list, not render nothing')
if (!usedOfficial) throw new Error('collapsed sidebar did not fall back to the official component')

/* -------------------------------------------------------- locale parity and text */

const enKeys = Object.keys(EN).sort()
const zhKeys = Object.keys(ZH).sort()
console.log('locale keys:', enKeys.length, '/', zhKeys.length)
if (enKeys.length !== zhKeys.length) throw new Error('locale parity broken')
if (enKeys.some((key, index) => key !== zhKeys[index])) throw new Error('locale key sets differ')

const everyText = textOf(tree)
console.log('sample text:', JSON.stringify(everyText.slice(0, 12)))
if (everyText.some(text => text.startsWith('tree.') || text.startsWith('error.'))) {
  throw new Error('untranslated key leaked into the tree: ' + JSON.stringify(everyText))
}

/* -------------------------------------------------------------- teardown restores */

for (const dispose of disposers) {
  if (typeof dispose === 'function') dispose()
}
console.log('after dispose, occupant restored:', officialOccupant.component === OfficialBrowser)
if (officialOccupant.component !== OfficialBrowser) throw new Error('teardown did not restore the official component')

console.log('OK')
process.exit(0)
