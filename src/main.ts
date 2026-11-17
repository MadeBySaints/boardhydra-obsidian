import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian'
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
      if (params.code) this.connectWithCode(params.code)
    })
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => this.syncNow() })
    this.addCommand({ id: 'connect', name: 'Connect to BoardHydra', callback: () => this.openConnect() })
    this.addCommand({
      id: 'add-card-note',
      name: 'Add a note to this card',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile()
        if (!f || !this.settings.key) return false
        if (checking) return true
        this.engine.newNoteFor(f.path).then((p) => {
          if (!p) return new Notice('BoardHydra: open a card note first.')
          this.app.workspace.openLinkText(p, '', true)
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
    this.settings = Object.assign({}, DEFAULTS, await this.loadData())
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

  constructor(app: App, private plugin: BoardHydraPlugin) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    const p = this.plugin
    const s = p.settings
    containerEl.empty()

    new Setting(containerEl).setName('Account').setHeading()
    if (s.key) {
      new Setting(containerEl)
        .setName(s.userName ? `Connected as ${s.userName}` : 'Connected')
        .setDesc('Obsidian sync is part of BoardHydra Pro. Disconnecting removes this vault’s key; your notes stay.')
        .addButton((b) => b.setButtonText('Disconnect').setWarning().onClick(async () => { await p.disconnect(); this.boards = null; this.display() }))
    } else {
      new Setting(containerEl)
        .setName('Connect')
        .setDesc('Opens BoardHydra in your browser. Sign in, choose Connect, and you’ll come back here. Needs BoardHydra Pro.')
        .addButton((b) => b.setButtonText('Connect').setCta().onClick(() => p.openConnect()))
      let code = ''
      new Setting(containerEl)
        .setName('Paste code')
        .setDesc('If Obsidian didn’t open by itself, paste the code the website showed you.')
        .addText((t) => t.setPlaceholder('Code').onChange((v) => { code = v }))
        .addButton((b) => b.setButtonText('Use code').onClick(async () => {
          if (!code.trim()) return
          await p.connectWithCode(code)
          this.display()
        }))
    }

    new Setting(containerEl).setName('Boards').setHeading()
    if (!s.key) {
      containerEl.createEl('p', { text: 'Connect first to choose boards.', cls: 'setting-item-description' })
    } else if (this.boards === null && !this.boardsErr) {
      containerEl.createEl('p', { text: 'Loading your boards…', cls: 'setting-item-description' })
      p.api.boards().then((b) => { this.boards = b; this.display() }).catch((e) => {
        this.boardsErr = e instanceof ApiError ? e.message : 'Couldn’t load your boards'
        this.display()
      })
    } else if (this.boardsErr) {
      containerEl.createEl('p', { text: this.boardsErr, cls: 'setting-item-description mod-warning' })
    } else {
      for (const b of this.boards ?? []) {
        new Setting(containerEl).setName(b.name).addToggle((t) => t.setValue(s.boards.includes(b.id)).onChange(async (on) => {
          s.boards = on ? [...new Set([...s.boards, b.id])] : s.boards.filter((x) => x !== b.id)
          await p.saveSettings()
          await p.engine.restart()
          await p.saveSettings()
        }))
      }
    }

    new Setting(containerEl).setName('Sync').setHeading()
    new Setting(containerEl)
      .setName('Folder')
      .setDesc('Where board folders go in this vault. Each board, list and card gets a note, linked board → lists → cards.')
      .addText((t) => t.setValue(s.root).onChange(async (v) => { s.root = v.trim() || 'BoardHydra'; await p.saveSettings() }))
    new Setting(containerEl)
      .setName('Kanban note')
      .setDesc('Also write a _Kanban note per board for the Kanban plugin, where dragging a card moves it. It links to every card, so the graph gets busier.')
      .addToggle((t) => t.setValue(s.kanban).onChange(async (on) => { s.kanban = on; await p.saveSettings(); await p.engine.restart() }))
    new Setting(containerEl)
      .setName('Checklist notes')
      .setDesc('A small note for each checklist, item and sub-item, linked to its card, so checklists grow around their card in the graph. Edit checklists in the card note.')
      .addToggle((t) => t.setValue(s.checklists).onChange(async (on) => { s.checklists = on; await p.saveSettings(); await p.engine.restart() }))
    new Setting(containerEl)
      .setName('Sync now')
      .setDesc(p.status.text || 'Reloads every chosen board (one request each).')
      .addButton((b) => b.setButtonText('Sync now').onClick(async () => { await p.syncNow(); this.display() }))
    new Setting(containerEl)
      .setName('Server')
      .setDesc('Only change this for a self-hosted or test server.')
      .addText((t) => t.setValue(s.server).onChange(async (v) => { s.server = v.trim() || DEFAULTS.server; await p.saveSettings() }))
  }
}
