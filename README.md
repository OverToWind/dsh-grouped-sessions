# dsh-grouped-sessions

<img src="assets/icon-180.png" width="72" height="72" alt="dsh-grouped-sessions icon" align="left" hspace="12" vspace="4">

Group the sessions of a DeepSeek Harness workspace without leaving the sidebar. The
workspace → session region becomes a three-level tree: open a workspace, pick a group,
pick a session. Ships as a Cordis bundle plugin for the DSH web UI.

<br clear="left">

## Features

- **Sidebar tree** — the shell's own session region renders 工作区 → 分组 → 会话. Each
  workspace expands to its groups plus an `Ungrouped` row holding every session that is
  not filed yet.
- **Groups per workspace** — `+` on a workspace row creates a group inside it; the `+` in
  the header creates one in the workspace you are currently in. Both expand the target
  workspace so the name field is always visible.
- **Two ways to file** — drag a session row onto a group, or use the row's `⋯` menu and
  pick a group. The menu is the keyboard path and the only path when the sidebar is
  narrow; dragging is the shortcut. Only the plugin's own drag flavour is accepted, so
  text dragged in from elsewhere is never filed.
- **Open on click** — clicking a row opens that session in the conversation panel.
- **Rename, delete and reorder** — from the group's `⋯` menu. Deleting a group keeps its
  sessions: they fall back to `Ungrouped`. Renaming validates before closing the field, so
  an empty name shows an inline error instead of discarding what you typed. `Move up` /
  `Move down` shift a group past its neighbour in the same workspace, so the groups you
  use most can sit at the top; the move lands at the first or last position and disables
  itself there. The `Ungrouped` row has its own `⋯` menu with the same two moves (it has no
  name or record to rename or delete), so the bucket can sit above or below the groups.
- **Live row metadata** — title, running dot and relative last-activity time per session,
  and a per-group count that follows the rows actually shown.
- **Filter** — the header search filters every workspace at once; a query matching
  nothing shows a single "no matches" line instead of an empty state under each group.
- **Groups start collapsed** — a group you created is closed until you open it, so a
  workspace opens as a short list of group names; `Ungrouped` starts open because it is
  where unfiled sessions land. Opening a group, collapsing a workspace, closing the
  `Ungrouped` bucket and where that bucket sits are all remembered in `localStorage`
  (`dsh-session-groups.sidebar`), and filing a session into a closed group opens that group
  so the row does not vanish.
- **Localized** — every string follows the shell language (en / zh) and a language change
  applies without a reload.

The agent can do the same work through the `session_groups` tool (`list`, `create`,
`rename`, `reorder`, `move`, `delete`, `assign`), so grouping also works from a prompt.
The bucket is a rendering detail rather than a stored record, so its slot stays a local
preference and is not exposed to the tool.

## Install

```bash
# from GitHub
dsh plugin --profile <profile> add github:OverToWind/dsh-grouped-sessions
```

Or, inside a DSH session, install a local clone with
`plugin_manager action=install_bundle target=<path to a local clone>`.
Refresh the window after installing.

## How the takeover stays safe

The sidebar region is a single slot (`sidebar.workspaces`), so the plugin swaps the
occupant's component and keeps the official one aside. Three guards:

- an error boundary renders the official region again if the tree throws, so a bug can
  never blank the whole left column;
- the official props (`useWorkspaces`, `useSessions`, `wide`, `openSession`,
  `startSession`, …) are reused rather than re-derived, so workspace and session state
  stays the shell's;
- disposing the plugin restores the original component, and a collapsed sidebar
  (`wide: false`) renders the official region, so session browsing never disappears.

## Mount points

| Purpose | Slot | How |
| --- | --- | --- |
| Sidebar session region | `sidebar.workspaces` | occupant `component` swapped, official kept as fallback |
| Group store + HTTP API | `/api/dsh-grouped-sessions/{state,mutate}` | Host routes, loopback only |
| Agent tool | `session_groups` | `ctx.tools.register` |

## Where the data lives

`~/.dsh/dsh-grouped-sessions.json` (or `$DSH_HOME/dsh-grouped-sessions.json`), served over
the plugin's own loopback routes. One small document, written atomically, safe to read or
repair by hand:

```json
{
  "version": 1,
  "groups": [
    {
      "id": "group-…",
      "workspaceId": "ws-…",
      "name": "Release prep",
      "order": 0,
      "sessionIds": ["…"]
    }
  ]
}
```

If that file does not exist yet, the Host also reads the pre-rename
`~/.dsh/dsh-session-groups.json`, so upgrading never loses your groups.

## Notes

- Groups belong to a workspace: switching workspaces shows a different set of groups, and
  the tree always shows every workspace at once.
- Assignment is single-valued: a session lives in at most one group.
- A group's count follows the rows actually shown, so a stale stored id never makes an
  empty group look populated.
- Host rejections come back as stable codes (`missing-name`, `unknown-group`,
  `invalid-direction`, …) and are translated in the UI instead of leaking English into a
  localized sidebar.
- `order` is per workspace: a move renumbers only that workspace's groups, so the other
  workspaces keep the way you arranged them.

## Development

`node scripts/smoke.mjs` loads `client.js` headlessly, swaps a fake official occupant,
renders the tree and asserts the drag / menu / assign / create / move paths, the default
collapsed state, locale parity and that teardown restores the official component.

## License

MIT
