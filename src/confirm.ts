import { App, Modal, Setting } from 'obsidian'

/** Asks before a deleted or moved note archives a pinned card. Resolves true for Archive; closing means Keep. */
export function confirmArchive(app: App, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let archive = false
    const modal = new (class extends Modal {
      onOpen() {
        this.titleEl.setText('Archive a pinned card?')
        this.contentEl.createEl('p', { text: `“${name}” is pinned. Archiving it removes the pin.` })
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText('Keep').onClick(() => this.close()))
          .addButton((b) => b.setButtonText('Archive').setCta().onClick(() => { archive = true; this.close() }))
      }
      onClose() {
        this.contentEl.empty()
        resolve(archive)
      }
    })(app)
    modal.open()
  })
}
