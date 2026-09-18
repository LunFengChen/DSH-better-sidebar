/**
 * EditorHost (the files window): in merged (in-place) mode a path-less tab
 * renders the empty-state hint with the tree dock open, and the header's
 * tree toggle persists its flag through ctx.betterSidebar.updateTab
 * (meta.treeOpen rides the tab's persisted layout). The editorExplorer pref
 * controls TREE-CLICK file-open behavior — in-place rewrites the current tab
 * via updateTab, split opens a per-path dedupe tab via openSidebarFile. The
 * path bar always navigates THIS tab. In split mode a PATH-LESS window is
 * the standalone explorer (path bar + tree); folder windows keep the path bar.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { api } from '../src/client/api.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { createBetterSidebarService, type FileViewerProps } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** A store with the seeded editor-home tab (default prefs: separate mode;
 *  merged-mode scenarios re-enable editorExplorer explicitly). */
function setup(): {
  store: ReturnType<typeof createSidebarStore>
  ctx: Context
  homeTab: () => SidebarTab
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // The openTab path needs a registered editor descriptor (dedupe by path).
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  store.setSession('editor-home-session')
  // The workbench seeds EMPTY (the right panel that used to carry the default
  // files window is DSH's native Sidebar now), so these editor-host scenarios
  // open the path-less files window explicitly — exactly what the shell does
  // when the files page is opened.
  service.openTab({ type: 'editor', title: 'Files', meta: { treeOpen: true } })
  const homeTab = (): SidebarTab =>
    allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
      .find(tab => tab.type === 'editor' && tab.path === undefined)!
  // openSidebarFile reads the session cwd from ctx.sessions.
  const sessionsSnapshot = { byId: { 'editor-home-session': { cwd: '/tmp' } }, current: 'editor-home-session' }
  const ctx = {
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  return { store, ctx, homeTab }
}

/** Mount the host for one tab; returns the container and an unmount helper. */
function mountHost(ctx: Context, store: ReturnType<typeof createSidebarStore>, tab: () => SidebarTab): {
  container: HTMLDivElement
  rerender: () => void
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (): void => {
    root.render(createElement(EditorHost, {
      ctx,
      store,
      scope: { sessionId: 'editor-home-session' },
      tab: tab(),
      expanded: [],
      revealed: [],
      onToggleDir: () => {},
      onReferenceFile: () => {},
    }))
  }
  act(render)
  return {
    container,
    // The real app re-renders the host with the fresh tab on every store
    // change (Sidebar subscribes); mirror that after mutating the store.
    rerender: () => { act(render) },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Type into the controlled path input (native setter) and press Enter. */
function typeAndCommit(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('EditorHost (files window)', () => {
  it('a path-less tab renders the empty-state hint with the tree panel open', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const html = container.innerHTML
      // The empty-state hint renders instead of the viewer loading flow.
      expect(html).toContain('Pick a file from the tree panel')
      expect(html).not.toContain('Loading…')
      // The header carries the path input and the pressed tree toggle; the
      // docked panel (search box) is open by default for path-less tabs.
      expect(container.querySelector('input')).not.toBeNull()
      const toggle = container.querySelector('button[aria-pressed]')
      expect(toggle?.getAttribute('aria-pressed')).toBe('true')
      // No cwd: the embedded tree renders its no-session placeholder
      // instead of touching the network.
      expect(html).toContain('Select a conversation')
    } finally {
      unmount()
    }
  })

  it('the tree toggle persists meta.treeOpen through updateTab', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    expect(homeTab().meta).toEqual({ treeOpen: true })
    const { container, rerender, unmount } = mountHost(ctx, store, homeTab)
    try {
      act(() => {
        container.querySelector('button[aria-pressed]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(homeTab().meta).toEqual({ treeOpen: false })
      // The store change re-renders the host with the fresh tab (Sidebar's
      // subscription in the real app); the second click flips it back.
      rerender()
      expect(container.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('false')
      act(() => {
        container.querySelector('button[aria-pressed]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(homeTab().meta).toEqual({ treeOpen: true })
    } finally {
      unmount()
    }
  })

  it('in-place mode: the path input Enter switches the CURRENT tab (stable id, meta kept)', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const before = homeTab()
      typeAndCommit(container.querySelector('input')!, '/tmp/a.ts')
      // The same tab id now carries the file (homeTab's path-less finder no
      // longer matches — look the tab up by id).
      const after = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.id === before.id)!
      expect(after.id).toBe(before.id)
      expect(after.path).toBe('/tmp/a.ts')
      expect(after.title).toBe('a.ts')
      expect(after.meta).toEqual({ treeOpen: true, dir: false })
      // No new tab landed.
      expect(allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)).toHaveLength(1)
    } finally {
      unmount()
    }
  })

  it('split mode: a file tab\'s path input Enter navigates THIS tab (no new tab)', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.id === 'editor:/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      typeAndCommit(container.querySelector('input[placeholder^="File or folder path"]')!, '/tmp/b.ts')
      const tabs = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
      // home + the same file tab, now at b.ts
      expect(tabs).toHaveLength(2)
      expect(fileTab().path).toBe('/tmp/b.ts')
      expect(fileTab().title).toBe('b.ts')
      expect(fileTab().id).toBe('editor:/tmp/a.ts')
    } finally {
      unmount()
    }
  })

  it('split mode: the path-less window is the standalone explorer (path bar + tree)', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      expect(container.querySelector('input[placeholder^="File or folder path"]')).not.toBeNull()
      expect(container.querySelector('button[aria-pressed]')).toBeNull()
      expect(container.querySelector('[role="separator"]')).toBeNull()
      expect(container.querySelector('input[placeholder^="Search files"]')).not.toBeNull()
      expect(container.innerHTML).toContain('Select a conversation')
    } finally {
      unmount()
    }
  })

  it('split mode: a file tab keeps the full chrome (path input + tree toggle + dock)', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts', meta: { treeOpen: true },
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      expect(container.querySelector('input[placeholder^="File or folder path"]')).not.toBeNull()
      expect(container.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true')
      expect(container.querySelector('[role="separator"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('dragging the panel edge resizes the dock and persists meta.treeWidth on release', async () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const handle = container.querySelector('[role="separator"]')!
      expect(handle).not.toBeNull()
      // The dock starts at the default width.
      const dock = handle.parentElement!
      expect(dock.style.width).toBe('240px')
      // Drag the left edge LEFT by 100px → the right-docked panel widens.
      // Pointer capture keeps move/up on the handle (jsdom: MouseEvent with
      // pointer* type names; setPointerCapture is absent and skipped).
      // Moves are batched to one application per frame (#315), so flush the
      // pending frame before asserting the width.
      act(() => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300 }))
        handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200 }))
      })
      await act(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      })
      expect(dock.style.width).toBe('340px')
      // Release: the drag state clears and the width persists on the tab.
      act(() => { handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 200 })) })
      expect(homeTab().meta).toEqual({ treeOpen: true, treeWidth: 340 })
    } finally {
      unmount()
    }
  })

  it('the header hosts the viewer toolbar (mode toggle / dirty dot / save)', () => {
    const { store, ctx } = setup()
    const service = ctx.betterSidebar
    const calls: string[] = []
    // A viewer with a hoisted toolbar (the TextEditor contract): register
    // commands and report the state once on mount. Capitalized so the hooks
    // rules recognize it as a component.
    const FakeViewer = (viewerProps: FileViewerProps): ReactNode => {
      useEffect(() => {
        viewerProps.onToolbarControls?.({
          setMode: (next) => { calls.push(`mode:${next}`) },
          save: () => { calls.push('save') },
        })
        viewerProps.onToolbarState?.({ modes: true, mode: 'preview', dirty: true, editable: true, saveState: 'idle' })
        return () => { viewerProps.onToolbarControls?.(null) }
        // Mount-only: re-running would re-fire the toolbar registration.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return null
    }
    service.registerFileViewer({
      id: 'test:fake',
      exts: ['fake'],
      fetchStrategy: 'none',
      component: FakeViewer,
    })
    service.openTab({ type: 'editor', title: 'x.fake', path: '/tmp/x.fake', id: 'editor:/tmp/x.fake' })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/x.fake')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      // Mode toggle + dirty dot + save button sit in the header row.
      const header = container.querySelector('input')!.parentElement!
      const buttons = [...header.querySelectorAll('button')]
      expect(buttons.map(b => b.textContent)).toContain('Preview')
      expect(buttons.map(b => b.textContent)).toContain('Edit')
      expect(header.querySelector('button[aria-label="Save"]')).not.toBeNull()
      expect(header.querySelector('[title="Unsaved"]')).not.toBeNull()
      // The header commands reach the viewer's registered controls.
      act(() => { buttons.find(b => b.textContent === 'Edit')!.click() })
      act(() => { header.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!.click() })
      expect(calls).toEqual(['mode:edit', 'save'])
    } finally {
      unmount()
    }
  })

  it('a folder tab (meta.dir) renders the tree rooted at the folder, with the path bar', () => {
    const { store, ctx } = setup()
    ctx.betterSidebar!.openTab({
      type: 'editor',
      title: 'src',
      path: '/work/src',
      id: 'editor:/work/src',
      meta: { dir: true },
    }, { sessionId: 'editor-home-session' })
    const dirTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/work/src')!
    const { container, unmount } = mountHost(ctx, store, dirTab)
    try {
      const html = container.innerHTML
      expect(html).toContain('src')
      expect(html).toContain('Search files by name…')
      expect(html).not.toContain('Pick a file from the tree panel')
      expect(container.querySelector('input[placeholder^="File or folder path"]')).not.toBeNull()
      expect(container.querySelector('button[aria-pressed]')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('path input ~ still navigates when session.cwd fails (host expands ~)', async () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    vi.spyOn(api, 'sessionCwd').mockRejectedValue(new Error('offline'))
    const tabId = homeTab().id
    const liveTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.id === tabId)!
    const { container, unmount } = mountHost(ctx, store, liveTab)
    try {
      typeAndCommit(container.querySelector('input[placeholder^="File or folder path"]')!, '~/notes.md')
      await act(async () => { await Promise.resolve() })
      expect(liveTab().path).toBe('~/notes.md')
    } finally {
      unmount()
      vi.restoreAllMocks()
    }
  })

  it('path input ~ expands against session.cwd home and navigates this tab', async () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    vi.spyOn(api, 'sessionCwd').mockResolvedValue({
      sessionId: 'editor-home-session',
      cwd: '/tmp',
      root: 'tmp',
      parent: '/',
      home: '/home/me',
    })
    const tabId = homeTab().id
    const liveTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.id === tabId)!
    const { container, unmount } = mountHost(ctx, store, liveTab)
    try {
      typeAndCommit(container.querySelector('input[placeholder^="File or folder path"]')!, '~/notes.md')
      await act(async () => { await Promise.resolve() })
      expect(liveTab().path).toBe('/home/me/notes.md')
      expect(liveTab().title).toBe('notes.md')
    } finally {
      unmount()
      vi.restoreAllMocks()
    }
  })
})
