import { z } from 'zod'
import {
  ElectronSidecarTabSchema,
  type ElectronSidecarPage,
  type ElectronSidecarTabRegistry
} from './electron-sidecar-tab-registry'

const BrowserPageResult = z.object({ browserPageId: z.string() }).passthrough()
const BrowserCloseResult = z.object({ closed: z.boolean() }).passthrough()
const BrowserTabListResult = z.object({ tabs: z.array(ElectronSidecarTabSchema) }).passthrough()

export type SidecarCommandResultContext = {
  requestedPageId: string | undefined
  requestedIndex: number | undefined
  worktreeId: string | undefined
  targetPage: ElectronSidecarPage | undefined
}

/** Maps sidecar results back to public page IDs and updates the tab registry. */
export function rewriteSidecarCommandResult(
  tabs: ElectronSidecarTabRegistry,
  method: string,
  result: unknown,
  context: SidecarCommandResultContext
): unknown {
  const { requestedPageId, requestedIndex, worktreeId, targetPage } = context
  if (method === 'browserTabCreate') {
    const created = BrowserPageResult.parse(result)
    const page = tabs.register(created.browserPageId, requestedPageId, worktreeId)
    return { ...created, browserPageId: page.publicPageId }
  }
  if (method === 'browserTabList') {
    const listed = BrowserTabListResult.parse(result)
    return { ...listed, tabs: tabs.reconcileTabs(listed.tabs, worktreeId) }
  }
  if (method === 'browserTabSwitch') {
    const switched = BrowserPageResult.parse(result)
    const page = tabs.pageForSidecar(switched.browserPageId)
    if (page) {
      tabs.setActive(page)
    }
    return {
      ...switched,
      ...(requestedIndex !== undefined ? { switched: requestedIndex } : {}),
      browserPageId: tabs.publicPageId(switched.browserPageId)
    }
  }
  if (method === 'browserTabClose' && targetPage) {
    const closed = BrowserCloseResult.parse(result)
    if (closed.closed) {
      tabs.delete(targetPage)
    }
    return closed
  }
  if (method === 'browserTabProfileClone') {
    const cloned = BrowserPageResult.parse(result)
    tabs.register(cloned.browserPageId, undefined, targetPage?.worktreeId)
  }
  return tabs.rewriteResult(result)
}
