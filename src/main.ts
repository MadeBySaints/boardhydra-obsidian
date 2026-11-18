import { App, Notice, Plugin, PluginSettingTab } from 'obsidian'
import type { SettingDefinitionItem, SettingGroupItem } from 'obsidian'
import { Api, ApiError } from './api'
import { Settings, Status, SyncEngine, genId } from './sync'
import type { BHBoard } from './types'

const DEFAULTS: Settings = {
  server: 'https://boardhydra.com',
  key: '',
  vault: '',
  userName: '',
  boards: [],
  root: 'BoardHydra',
  folders: {},
  clientId: '',
  kanban: false,
  checklists: true,
}

export default class BoardHydraPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS }
  api!: Api
  engine!: SyncEngine
  status: Status = { text: '' }
  private statusEl!: HTMLElement

  async onload() {
    await this.loadSettings()
    if (!this.settings.clientId) {
      this.settings.clientId = 'obsidian-' + genId()
      await this.saveSettings()
    }
    this.api = new Api(() => this.settings.server, () => this.settings.key, this.settings.clientId)
    this.statusEl = this.addStatusBarItem()
    this.engine = new SyncEngine(this.app, this.api, () => this.settings, (st) => this.setStatus(st))
    this.addSettingTab(new BoardHydraSettingTab(this.app, this))

    this.registerObsidianProtocolHandler('boardhydra', (params) => {
      if (params.code) void this.connectWithCode(params.code)
    })
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => this.syncNow() })
    this.addCommand({ id: 'connect', name: 'Connect account', callback: () => this.openConnect() })
    this.addCommand({
      id: 'add-card-note',
      name: 'Add a note to this card',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile()
        if (!f || !this.settings.key) return false
        if (checking) return true
        void this.engine.newNoteFor(f.path).then((p) => {
          if (!p) { new Notice('BoardHydra: open a card note first.'); return }
          return this.app.workspace.openLinkText(p, '', true)
        })
        return true
      },
    })

    this.app.workspace.onLayoutReady(async () => {
      // watch the vault only after it has loaded, so start-up doesn't look like a flood of edits
      this.registerEvent(this.app.vault.on('modify', (f) => this.engine.onLocalChange(f)))
      this.registerEvent(this.app.vault.on('create', (f) => this.engine.onLocalChange(f)))
      this.registerEvent(this.app.vault.on('rename', (f, old) => this.engine.onLocalRename(f, old)))
      this.registerEvent(this.app.vault.on('delete', (f) => this.engine.onLocalDelete(f)))
      await this.engine.start()
      await this.saveSettings() // board folder names chosen on first sync
    })
  }

  onunload() {
    this.engine?.stop()
  }

  setStatus(st: Status) {
    this.status = st
    this.statusEl.setText(st.text)
    this.statusEl.toggleClass('bh-status', true)
    this.statusEl.toggleClass('is-error', !!st.error)
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<Settings> | null
    this.settings = { ...DEFAULTS, ...saved }
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  openConnect() {
    const vault = this.app.vault.getName()
    window.open(`${this.settings.server.replace(/\/+$/, '')}/connect/obsidian?vault=${encodeURIComponent(vault)}`)
  }

  async connectWithCode(code: string) {
    try {
      const r = await this.api.exchange(code.trim())
      this.settings.key = r.key
      this.settings.vault = r.vault
      this.settings.userName = r.user?.name ?? ''
      await this.saveSettings()
      new Notice(`BoardHydra: connected${this.settings.userName ? ' as ' + this.settings.userName : ''}. Choose boards to sync in the plugin settings.`)
      await this.engine.restart()
    } catch (e) {
      new Notice('BoardHydra: ' + (e instanceof Error ? e.message : 'could not connect'), 10000)
    }
  }

  async disconnect() {
    this.engine.stop()
    // give the key up on the server too; forget it here even if that fails (it can be removed on the website)
    if (this.settings.key) await this.api.revoke().catch(() => new Notice('BoardHydra: couldn’t reach BoardHydra. Remove this vault under Account → Integrations on the website.', 10000))
    this.settings.key = ''
    this.settings.userName = ''
    await this.saveSettings()
    this.setStatus({ text: 'BoardHydra: not connected' })
  }

  async syncNow() {
    if (!this.settings.key) return this.openConnect()
    await this.engine.restart()
    await this.saveSettings()
    if (!this.engine.paused) new Notice('BoardHydra: synced')
  }
}

class BoardHydraSettingTab extends PluginSettingTab {
  private boards: BHBoard[] | null = null
  private boardsErr = ''
  private loading = false
  private code = ''

  constructor(app: App, private plugin: BoardHydraPlugin) {
    super(app, plugin)
  }

  /** Forget the board list (and any error loading it) so the next visit loads it fresh. */
  hide(): void {
    this.boards = null
    this.boardsErr = ''
    super.hide()
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as keyof Settings]
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const p = this.plugin
    const s = p.settings
    if (key === 'root') s.root = String(value).trim() || DEFAULTS.root
    else if (key === 'server') s.server = String(value).trim() || DEFAULTS.server
    else if (key === 'kanban' || key === 'checklists') s[key] = value === true
    else return
    await p.saveSettings()
    if (key === 'kanban' || key === 'checklists') await p.engine.restart()
  }

  /** Loads the board list, then redraws the tab. Started by the "Loading" row, so it never runs at start-up. */
  private loadBoards() {
    if (this.loading) return
    this.loading = true
    this.plugin.api.boards()
      .then((b) => { this.boards = b })
      .catch((e) => { this.boardsErr = e instanceof ApiError ? e.message : 'Couldn’t load your boards' })
      .finally(() => { this.loading = false; this.update() })
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const p = this.plugin
    const s = p.settings

    const account: SettingGroupItem[] = s.key
      ? [{
          name: s.userName ? `Connected as ${s.userName}` : 'Connected',
          desc: 'Obsidian sync is part of BoardHydra Pro. Disconnecting removes this vault’s key; your notes stay.',
          aliases: ['disconnect', 'account'],
          render: (row) => {
            row.addButton((b) => b.setButtonText('Disconnect').setDestructive().onClick(async () => {
              await p.disconnect()
              this.boards = null
              this.update()
            }))
          },
        }]
      : [{
          name: 'Connect',
          desc: 'Opens BoardHydra in your browser. Sign in, choose Connect, and you’ll come back here. Needs BoardHydra Pro.',
          aliases: ['sign in', 'account'],
          render: (row) => { row.addButton((b) => b.setButtonText('Connect').setCta().onClick(() => p.openConnect())) },
        }, {
          name: 'Paste code',
          desc: 'If Obsidian didn’t open by itself, paste the code the website showed you.',
          render: (row) => {
            row.addText((t) => t.setPlaceholder('Code').setValue(this.code).onChange((v) => { this.code = v }))
            row.addButton((b) => b.setButtonText('Use code').onClick(async () => {
              if (!this.code.trim()) return
              await p.connectWithCode(this.code)
              this.code = ''
              this.update()
            }))
          },
        }]

    let boards: SettingGroupItem[]
    if (!s.key) {
      boards = [{ name: 'Connect first to choose boards.', searchable: false }]
    } else if (this.boardsErr) {
      boards = [{
        name: 'Couldn’t load your boards',
        desc: this.boardsErr,
        searchable: false,
        render: (row) => {
          row.descEl.addClass('mod-warning')
          row.addButton((b) => b.setButtonText('Try again').onClick(() => { this.boardsErr = ''; this.update() }))
        },
      }]
    } else if (this.boards === null) {
      boards = [{ name: 'Loading your boards…', searchable: false, render: () => this.loadBoards() }]
    } else if (!this.boards.length) {
      boards = [{ name: 'You have no boards yet.', searchable: false }]
    } else {
      boards = this.boards.map((b): SettingGroupItem => ({
        name: b.name,
        render: (row) => {
          row.addToggle((t) => t.setValue(s.boards.includes(b.id)).onChange(async (on) => {
            s.boards = on ? [...new Set([...s.boards, b.id])] : s.boards.filter((x) => x !== b.id)
            await p.saveSettings()
            await p.engine.restart()
            await p.saveSettings()
          }))
        },
      }))
    }

    return [
      { type: 'group', heading: 'Account', items: account },
      { type: 'group', heading: 'Boards', items: boards },
      {
        type: 'group',
        heading: 'Sync',
        items: [
          {
            name: 'Folder',
            desc: 'Where board folders go in this vault. Each board, list and card gets a note, linked board → lists → cards.',
            control: { type: 'text', key: 'root', defaultValue: DEFAULTS.root },
          },
          {
            name: 'Kanban note',
            desc: 'Also write a _Kanban note per board for the Kanban plugin, where dragging a card moves it. It links to every card, so the graph gets busier.',
            control: { type: 'toggle', key: 'kanban', defaultValue: DEFAULTS.kanban },
          },
          {
            name: 'Checklist notes',
            desc: 'A small note for each checklist, item and sub-item, linked to its card, so checklists grow around their card in the graph. Edit checklists in the card note.',
            control: { type: 'toggle', key: 'checklists', defaultValue: DEFAULTS.checklists },
          },
          {
            name: 'Sync now',
            desc: p.status.text || 'Reloads every chosen board (one request each).',
            render: (row) => {
              row.addButton((b) => b.setButtonText('Sync now').onClick(async () => { await p.syncNow(); this.update() }))
            },
          },
          {
            name: 'Server',
            desc: 'Only change this for a self-hosted or test server.',
            control: { type: 'text', key: 'server', defaultValue: DEFAULTS.server },
          },
        ],
      },
    ]
  }
}
