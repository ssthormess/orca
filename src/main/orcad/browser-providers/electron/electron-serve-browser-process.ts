import {
  BROWSER_EXPECT_URL_RUNTIME_CAPABILITY,
  BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY
} from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import {
  BROWSER_EXPECT_URL_UNSUPPORTED_CODE,
  BrowserExpectedUrlMismatch
} from '../../../../shared/browser/client-hosting/browser-expected-url'
import { browserExpectedUrlMismatchError } from '../../../browser/cdp/input/browser-expected-page-url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { BrowserError } from '../../../browser/browser-error'
import type { RuntimeBrowserCommandHost } from '../../../runtime/browser/commands/browser-command-contracts'
import type { RuntimeBrowserCommands } from '../../../runtime/browser/commands/browser-commands'
import {
  findTransport,
  type RuntimeMetadata
} from '../../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { readRuntimeMetadata } from '../../../runtime/rpc/server/runtime-metadata'
import { spawnProcess } from '@orca/process-host'
import { isProcessAlive } from '../../../../shared/remote-runtime/serve-supervisor/serve-bundle-coordination'
import { removeTree } from '../../../../shared/file-write/windows-transient-lock-removal'
import { BROWSER_SIDECAR_OWNER_ENV } from '../../../../shared/browser/runtime/browser-sidecar-lifetime'
import { electronIsolatedProfileSwitches } from '../../../../shared/app-lifecycle/launch/electron-isolated-profile-switches'
import { headlessServeOzonePlatformSwitches } from '../../../../shared/app-lifecycle/launch/headless-serve-ozone-platform'
import { sendOrcadSidecarRequest } from '../orcad-sidecar-runtime-client'
import { electronServeBrowserScreencast } from './electron-serve-browser-screencast'
import type { BrowserScreencastStream } from '../../../runtime/browser/screencast/browser-screencast-contracts'
import { browserWaitRequestTimeoutMs } from '../../../../shared/browser/automation/browser-wait-timeout'
import { electronServeEnvironment } from './electron-serve-browser-environment'
import { reserveLoopbackPort } from './loopback-port-reservation'
import {
  launchOnElectronSidecarProfile,
  stopAnsweringElectronSidecar,
  stopElectronSidecar,
  type ElectronSidecarProfile
} from './electron-sidecar-profile'
import { ElectronSidecarTabRegistry } from './electron-sidecar-tab-registry'
import { resolveSidecarCommandTarget } from './electron-sidecar-command-target'
import { rewriteSidecarCommandResult } from './electron-sidecar-command-result'

const START_TIMEOUT_MS = 120_000
const RuntimeStatusResult = z.object({ capabilities: z.array(z.string()).optional() }).passthrough()

export class ElectronServeBrowserProcess {
  private child: ReturnType<typeof spawnProcess> | null = null
  private metadata: RuntimeMetadata | null = null
  private readonly tabs = new ElectronSidecarTabRegistry()
  private sidecarCapabilities: readonly string[] = []
  private sidecarProfile: ElectronSidecarProfile | null = null

  constructor(
    private readonly executablePath: string,
    private readonly orcadUserDataPath: string
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    this.sidecarCapabilities = []
    signal?.throwIfAborted()
    await launchOnElectronSidecarProfile(
      this.orcadUserDataPath,
      (profile) => this.launch(profile, signal),
      // Retry only an app that exited on its own, after this attempt is cleaned up.
      async () => (this.pid() === null && !signal?.aborted ? this.stop().then(() => true) : false)
    )
  }

  private async launch(profile: ElectronSidecarProfile, signal?: AbortSignal): Promise<void> {
    this.sidecarProfile = profile
    const userDataPath = profile.path
    const port = await reserveLoopbackPort()
    signal?.throwIfAborted()
    const child = spawnProcess({
      program: this.executablePath,
      args: [
        '--serve',
        '--serve-port',
        String(port),
        '--serve-json',
        '--serve-no-pairing',
        ...electronIsolatedProfileSwitches(process.env),
        ...headlessServeOzonePlatformSwitches(process.platform),
        `--user-data-dir=${userDataPath}`
      ],
      env: { ...electronServeEnvironment(userDataPath), [BROWSER_SIDECAR_OWNER_ENV]: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'json'
    })
    this.child = child
    let spawnError: unknown = null
    // Bundle swaps can race restart; report ENOENT as start failure without crashing orcad.
    child.on('error', (error) => {
      spawnError = error
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('error', () => undefined)
      stream?.resume()
    }
    const deadline = Date.now() + START_TIMEOUT_MS
    let lastError: unknown = null
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const metadata = readRuntimeMetadata(userDataPath)
      if (metadata) {
        try {
          const status = RuntimeStatusResult.parse(
            await sendOrcadSidecarRequest(metadata, 'status.get', undefined, 5_000)
          )
          signal?.throwIfAborted()
          if (status.capabilities?.includes('browser.headless.v1')) {
            this.sidecarCapabilities = status.capabilities
            this.metadata = metadata
            return
          }
          lastError = new Error('Installed Electron app omitted browser.headless.v1.')
        } catch (error) {
          lastError = error
        }
      }
      if (spawnError) {
        lastError = spawnError
        break
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        break
      }
      await delay(100, undefined, { signal })
    }
    throw new Error(
      `Installed Electron browser provider did not become ready: ${
        lastError instanceof Error ? lastError.message : 'no runtime metadata'
      }`
    )
  }

  createCommands(host: RuntimeBrowserCommandHost): RuntimeBrowserCommands {
    return new Proxy({} as RuntimeBrowserCommands, {
      // Startup checks membership before resolving commands dynamically.
      has: (_target, property) => typeof property === 'string' && property !== 'then',
      get: (_target, property) => {
        if (property === 'then' || typeof property !== 'string') {
          return undefined
        }
        return (...args: unknown[]) => this.invoke(host, property, args)
      }
    })
  }
  supportsGoogleCookieClear(): boolean {
    return (
      this.isAvailable() &&
      this.sidecarCapabilities.includes(BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY)
    )
  }

  supportsScreencast(): boolean {
    if (!this.isAvailable()) {
      return false
    }
    const transport = this.metadata && findTransport(this.metadata, 'unix', 'named-pipe')
    const transportStreams =
      transport !== null && (transport.kind === 'unix' || transport.kind === 'named-pipe')
        ? transport.streaming === true
        : false
    return (
      this.sidecarCapabilities.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY) && transportStreams
    )
  }

  isAvailable(): boolean {
    return this.metadata !== null && isProcessAlive(this.metadata.pid)
  }

  /** Read child exit state so recycled PIDs cannot identify an unrelated process. */
  pid(): number | null {
    const child = this.child
    return child?.pid && child.exitCode === null && child.signalCode === null ? child.pid : null
  }

  async stop(): Promise<void> {
    const childPid = this.pid()
    const { metadata, sidecarProfile: profile } = this
    this.child = null
    this.metadata = null
    this.sidecarCapabilities = []
    this.sidecarProfile = null
    this.tabs.clear()
    if (childPid !== null) {
      await stopElectronSidecar(metadata?.pid ?? childPid)
    } else if (metadata) {
      // The child is gone, so its pids may be recycled; signal only a sidecar that still answers.
      await stopAnsweringElectronSidecar(metadata)
    }
    if (profile && !profile.persistent) {
      // Windows helpers may briefly hold this temp profile; cleanup failure must not strand the instance lock.
      await removeTree(profile.path).catch((error: unknown) =>
        console.warn('[orcad] Electron browser sidecar data was not removed:', error)
      )
    }
  }

  private async invoke(
    host: RuntimeBrowserCommandHost,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const metadata = this.metadata
    if (!metadata) {
      throw new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        'The Electron browser provider is not running.'
      )
    }
    const original = (args[0] ?? {}) as Record<string, unknown>
    // The sidecar is the installed app, which can be older and would drop the field.
    if (
      original.expectUrl !== undefined &&
      !this.sidecarCapabilities.includes(BROWSER_EXPECT_URL_RUNTIME_CAPABILITY)
    ) {
      throw new BrowserError(
        BROWSER_EXPECT_URL_UNSUPPORTED_CODE,
        'The installed Orca app that runs this server’s browser cannot check --expect-url. Update it or drop the flag.'
      )
    }
    const prepared = await resolveSidecarCommandTarget(this.tabs, host, method, original)
    if (prepared.earlyResult !== undefined) {
      return prepared.earlyResult
    }
    const { rpcMethod, params, targetPage, worktreeId, requestedPageId, requestedIndex } = prepared

    if (method === 'browserScreencast') {
      try {
        return await electronServeBrowserScreencast(
          metadata,
          this.tabs,
          params,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: command args arrive untyped through the Proxy dispatch; callers pass the BrowserScreencastStream contract.
          (args[1] ?? {}) as BrowserScreencastStream
        )
      } catch (error) {
        if (
          targetPage &&
          error instanceof BrowserError &&
          (error.code === 'browser_tab_not_found' || error.code === 'browser_tab_closed')
        ) {
          this.tabs.delete(targetPage)
        }
        throw error
      }
    }

    let result: unknown
    try {
      result = await sendOrcadSidecarRequest(
        metadata,
        rpcMethod,
        params,
        method === 'browserWait' ? browserWaitRequestTimeoutMs(params.timeout) : undefined
      )
    } catch (error) {
      if (
        targetPage &&
        error instanceof BrowserError &&
        (error.code === 'browser_tab_not_found' || error.code === 'browser_tab_closed')
      ) {
        this.tabs.delete(targetPage)
      }
      // The sidecar named its own page id, which the caller's --page can't use.
      const mismatch =
        error instanceof BrowserError
          ? BrowserExpectedUrlMismatch.safeParse(this.tabs.rewriteResult(error.data))
          : null
      throw mismatch?.success ? browserExpectedUrlMismatchError(mismatch.data) : error
    }
    return rewriteSidecarCommandResult(this.tabs, method, result, {
      requestedPageId,
      requestedIndex,
      worktreeId,
      targetPage
    })
  }
}
