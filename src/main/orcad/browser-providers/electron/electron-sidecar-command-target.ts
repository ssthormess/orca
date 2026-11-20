import type { RuntimeBrowserCommandHost } from '../../../runtime/browser/commands/browser-command-contracts'
import {
  electronSidecarRuntimeMethodName,
  TARGETLESS_BROWSER_METHODS
} from './electron-sidecar-method-routing'
import type {
  ElectronSidecarPage,
  ElectronSidecarTabRegistry
} from './electron-sidecar-tab-registry'

export type ResolvedSidecarCommand = {
  rpcMethod: string
  params: Record<string, unknown>
  targetPage: ElectronSidecarPage | undefined
  worktreeId: string | undefined
  requestedPageId: string | undefined
  requestedIndex: number | undefined
  /** browserTabCreate returns early when the provisional page already exists. */
  earlyResult?: unknown
}

export async function resolveSidecarCommandTarget(
  tabs: ElectronSidecarTabRegistry,
  host: RuntimeBrowserCommandHost,
  method: string,
  original: Record<string, unknown>
): Promise<ResolvedSidecarCommand> {
  const worktreeId =
    typeof original.worktree === 'string'
      ? (await host.resolveBrowserWorkspace(original.worktree)).id
      : undefined
  const params: Record<string, unknown> = { ...original, worktree: undefined }
  const requestedPageId = typeof original.page === 'string' ? original.page : undefined
  const requestedIndex = typeof original.index === 'number' ? original.index : undefined
  let targetPage: ElectronSidecarPage | undefined
  let rpcMethod = electronSidecarRuntimeMethodName(method)
  let earlyResult: unknown
  if (method === 'browserTabCreate' && requestedPageId) {
    const existing = tabs.find(requestedPageId)
    if (existing) {
      tabs.require(requestedPageId, worktreeId)
      earlyResult = { browserPageId: requestedPageId }
      return {
        rpcMethod,
        params,
        targetPage,
        worktreeId,
        requestedPageId,
        requestedIndex,
        earlyResult
      }
    }
    // Sidecars mint their own IDs; adopt the caller's provisional ID after creation.
    delete params.page
  }

  if (method === 'browserTabCurrent' && worktreeId) {
    targetPage = tabs.active(worktreeId)
    rpcMethod = 'browser.tabShow'
    params.page = targetPage.sidecarPageId
  } else if (method === 'browserTabSwitch' || method === 'browserTabClose') {
    targetPage = requestedPageId
      ? tabs.require(requestedPageId, worktreeId)
      : requestedIndex !== undefined
        ? tabs.pageAt(worktreeId, requestedIndex)
        : worktreeId
          ? tabs.active(worktreeId)
          : undefined
    if (targetPage) {
      params.page = targetPage.sidecarPageId
      delete params.index
    }
  } else if (requestedPageId && method !== 'browserTabCreate') {
    targetPage = tabs.require(requestedPageId, worktreeId)
    params.page = targetPage.sidecarPageId
  } else if (worktreeId && !TARGETLESS_BROWSER_METHODS[method]) {
    targetPage = tabs.active(worktreeId)
    params.page = targetPage.sidecarPageId
  }
  return { rpcMethod, params, targetPage, worktreeId, requestedPageId, requestedIndex }
}
