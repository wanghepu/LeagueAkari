import  tools  from '@addons/tool.node'
import { IAkariShardInitDispose, Shard } from '@shared/akari-shard'
import { GameClientHttpApiAxiosHelper } from '@shared/http-api-axios-helper/game-client'
import axios from 'axios'
import cp from 'child_process'
import https from 'https'
import ofs from 'node:original-fs'
import path from 'node:path'

import { ClientInstallationMain } from '../client-installation'
import { AkariIpcMain } from '../ipc'
import { KeyboardShortcutsMain } from '../keyboard-shortcuts'
import { LeagueClientMain } from '../league-client'
import { AkariLogger, LoggerFactoryMain } from '../logger-factory'
import { MobxUtilsMain } from '../mobx-utils'
import { SettingFactoryMain } from '../setting-factory'
import { SetterSettingService } from '../setting-factory/setter-setting-service'
import { GameClientSettings } from './state'

export interface LaunchSpectatorConfig {
  locale?: string
  sgpServerId: string
  observerEncryptionKey: string
  observerServerPort: number
  observerServerIp: string
  gameId: number
  gameMode: string
}

/**
 * 处理游戏端相关的功能
 */
@Shard(GameClientMain.id)
export class GameClientMain implements IAkariShardInitDispose {
  static id = 'game-client-main'

  static GAME_CLIENT_PROCESS_NAME = 'League of Legends.exe'
  static GAME_CLIENT_BASE_URL = 'https://127.0.0.1:2999'

  private readonly _log: AkariLogger
  private readonly _setting: SetterSettingService

  private readonly _http = axios.create({
    baseURL: GameClientMain.GAME_CLIENT_BASE_URL,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      maxFreeSockets: 1024,
      maxCachedSessions: 2048
    })
  })
  private readonly _api: GameClientHttpApiAxiosHelper

  public readonly settings = new GameClientSettings()

  private _gcCachedRunningPids: number[] = []

  constructor(
    private readonly _ipc: AkariIpcMain,
    private readonly _loggerFactory: LoggerFactoryMain,
    private readonly _settingFactory: SettingFactoryMain,
    private readonly _lc: LeagueClientMain,
    private readonly _kbd: KeyboardShortcutsMain,
    private readonly _mobx: MobxUtilsMain,
    private readonly _ci: ClientInstallationMain
  ) {
    this._log = _loggerFactory.create(GameClientMain.id)
    this._api = new GameClientHttpApiAxiosHelper(this._http)

    this._setting = _settingFactory.register(
      GameClientMain.id,
      {
        terminateGameClientWithShortcut: { default: this.settings.terminateGameClientWithShortcut },
        terminateShortcut: { default: this.settings.terminateShortcut }
      },
      this.settings
    )
  }

  get http() {
    return this._http
  }

  get api() {
    return this._api
  }

  async onInit() {
    await this._setting.applyToState()
    this._mobx.propSync(GameClientMain.id, 'settings', this.settings, [
      'terminateGameClientWithShortcut',
      'terminateShortcut'
    ])
    this._handleIpcCall()
    this._handleShortcuts()
  }

  private _handleShortcuts() {
    if (this.settings.terminateShortcut) {
      try {
        this._kbd.register(
          `${GameClientMain.id}/terminate-game-client`,
          this.settings.terminateShortcut,
          'normal',
          () => {
            if (this.settings.terminateGameClientWithShortcut) {
              this._terminateGameClient()
            }
          }
        )
      } catch (error) {
        this._log.warn('初始化注册快捷键失败', this.settings.terminateShortcut)
      }
    }

    this._setting.onChange('terminateShortcut', async (value, { setter }) => {
      if (value === null) {
        this._kbd.unregisterByTargetId(`${GameClientMain.id}/terminate-game-client`)
      } else {
        try {
          this._kbd.register(`${GameClientMain.id}/terminate-game-client`, value, 'normal', () => {
            if (this.settings.terminateGameClientWithShortcut) {
              this._terminateGameClient()
            }
          })
        } catch (error) {
          this._log.warn('注册快捷键失败', value)
          await setter(null)
        }
      }

      await setter()
    })
  }

  private _handleIpcCall() {
    this._ipc.onCall(GameClientMain.id, 'terminateGameClient', () => {
      this._terminateGameClient()
    })

    this._ipc.onCall(GameClientMain.id, 'launchSpectator', (_, config: LaunchSpectatorConfig) => {
      return this.launchSpectator(config)
    })

    this._ipc.onCall(
      GameClientMain.id,
      'setSettingsFileReadonlyOrWritable',
      async (_, mode: 'readonly' | 'writable') => {
        await this._setSettingsFileReadonlyOrWritable(mode)
      }
    )

    this._ipc.onCall(GameClientMain.id, 'getSettingsFileReadonlyOrWritable', async () => {
      return this._getSettingsFileReadonlyOrWritable()
    })
  }

  private _terminateGameClient() {
    this._log.info('尝试终止游戏客户端进程')
    tools.getPidsByName(GameClientMain.GAME_CLIENT_PROCESS_NAME).forEach((pid) => {
      this._log.info('存在进程', pid)
      if (!tools.isProcessForeground(pid)) {
        this._log.info('进程非在前台', pid)
        return
      }

      this._log.info(`终止游戏客户端进程 ${pid}`)
      tools.terminateProcess(pid)
    })
  }

  /**
   * 连接情况下, 通过 LCU API 获取安装位置
   * 未连接的情况下, 默认使用腾讯服务端的安装位置
   * @param config
   * @returns
   */
  private async _completeSpectatorCredential(config: LaunchSpectatorConfig) {
    const {
      sgpServerId,
      gameId,
      gameMode,
      locale = 'zh_CN',
      observerEncryptionKey,
      observerServerIp,
      observerServerPort
    } = config

    if (this._lc.state.connectionState === 'connected') {
      try {
        const { data: location } = await this._lc.http.get<{
          gameExecutablePath: string
          gameInstallRoot: string
        }>('/lol-patch/v1/products/league_of_legends/install-location')

        return {
          sgpServerId,
          gameId,
          gameMode,
          locale,
          observerEncryptionKey,
          observerServerIp,
          observerServerPort,
          gameInstallRoot: location.gameInstallRoot,
          gameExecutablePath: location.gameExecutablePath
        }
      } catch (error) {
        const err = new Error('Cannot get game installation path')
        err.name = 'CannotGetGameInstallationPath'
        throw err
      }
    } else {
      if (this._ci.state.tencentInstallationPath) {
        const gameExecutablePath = path.resolve(
          this._ci.state.tencentInstallationPath,
          'Game',
          GameClientMain.GAME_CLIENT_PROCESS_NAME
        )

        const gameInstallRoot = path.resolve(this._ci.state.tencentInstallationPath, 'Game')

        return {
          sgpServerId,
          gameId,
          gameMode,
          locale,
          observerEncryptionKey,
          observerServerIp,
          observerServerPort,
          gameInstallRoot,
          gameExecutablePath
        }
      } else if (this._ci.state.leagueClientExecutablePaths.length) {
        const gameExecutablePath = path.resolve(
          this._ci.state.leagueClientExecutablePaths[0],
          '..',
          'Game',
          GameClientMain.GAME_CLIENT_PROCESS_NAME
        )

        try {
          await ofs.promises.access(gameExecutablePath)
          const gameInstallRoot = path.resolve(gameExecutablePath, '..')

          return {
            sgpServerId,
            gameId,
            gameMode,
            locale,
            observerEncryptionKey,
            observerServerIp,
            observerServerPort,
            gameInstallRoot,
            gameExecutablePath
          }
        } catch {
          const err = new Error('Cannot get game installation path')
          err.name = 'CannotGetGameInstallationPath'
          throw err
        }
      } else {
        const err = new Error('Cannot get game installation path')
        err.name = 'CannotGetGameInstallationPath'
        throw err
      }
    }
  }

  async launchSpectator(config: LaunchSpectatorConfig) {
    const {
      gameExecutablePath,
      gameInstallRoot,
      gameId,
      gameMode,
      locale,
      observerEncryptionKey,
      observerServerIp,
      observerServerPort,
      sgpServerId
    } = await this._completeSpectatorCredential(config)

    const [region, rsoPlatformId] = sgpServerId.split('_')

    const cmds = [
      `spectator ${observerServerIp}:${observerServerPort} ${observerEncryptionKey} ${gameId} ${region}`,
      `-GameBaseDir=${gameInstallRoot}`,
      `-Locale=${locale || 'zh_CN'}`,
      `-GameID=${gameId}`,
      `-Region=${region}`,
      `-UseNewX3D=1`,
      '-PlayerNameMode=ALIAS',
      '-UseNewX3DFramebuffers=1'
    ]

    if (gameMode === 'TFT') {
      cmds.push('-Product=TFT')
    } else {
      cmds.push('-Product=LoL')
    }

    if (rsoPlatformId) {
      cmds.push(`-PlatformId=${rsoPlatformId}`)
    }

    return new Promise<void>((resolve, reject) => {
      const p = cp.spawn(gameExecutablePath, cmds, {
        cwd: gameInstallRoot,
        detached: true
      })

      let hasError = false
      p.on('rejected', (err) => {
        reject(err)
      })

      setImmediate(() => {
        if (hasError) {
          return
        }

        p.unref()
        resolve()
      })
    })
  }

  static isGameClientForeground() {
    return tools
      .getPidsByName(GameClientMain.GAME_CLIENT_PROCESS_NAME)
      .some((pid) => tools.isProcessForeground(pid))
  }

  isGameClientForegroundCached() {
    if (this._gcCachedRunningPids.length === 0) {
      this._gcCachedRunningPids = tools.getPidsByName(GameClientMain.GAME_CLIENT_PROCESS_NAME)
    } else {
      this._gcCachedRunningPids = this._gcCachedRunningPids.filter((pid) =>
        tools.isProcessRunning(pid)
      )

      if (this._gcCachedRunningPids.length === 0) {
        this._gcCachedRunningPids = tools.getPidsByName(GameClientMain.GAME_CLIENT_PROCESS_NAME)
      }
    }

    return this._gcCachedRunningPids.some((pid) => tools.isProcessForeground(pid))
  }

  private async _setSettingsFileReadonlyOrWritable(mode: 'readonly' | 'writable' = 'readonly') {
    const settingsPath = path.join(await this._getConfigPathByLcuApi(), 'PersistedSettings.json')
    this._log.info(`设置文件 ${settingsPath} 为 ${mode}`)

    if (mode === 'readonly') {
      await ofs.promises.chmod(settingsPath, 0o444)
    } else {
      await ofs.promises.chmod(settingsPath, 0o644)
    }
  }

  private async _getSettingsFileReadonlyOrWritable() {
    const settingsPath = path.join(await this._getConfigPathByLcuApi(), 'PersistedSettings.json')
    const stats = await ofs.promises.stat(settingsPath)
    return stats.mode & 0o222 ? 'writable' : 'readonly'
  }

  private async _getConfigPathByLcuApi() {
    if (!this._lc.state.auth) {
      throw new Error('LC Not connected')
    }

    const { data: gameInstallRoot } = await this._lc.http.get<string>('/data-store/v1/install-dir')

    if (this._lc.state.auth.region === 'TENCENT') {
      return path.resolve(gameInstallRoot, '..', 'Game', 'Config')
    } else {
      return path.resolve(gameInstallRoot, 'Config')
    }
  }
}
