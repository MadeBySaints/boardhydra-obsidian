# BoardHydra for Obsidian

Sync your [BoardHydra](https://boardhydra.com) boards with your vault, both ways. Each card becomes a note,
and each board gets a Kanban note. Needs BoardHydra **Pro** or **Business**.

## Connect
1. Install the plugin and turn it on.
2. Settings → BoardHydra → **Connect**. Your browser opens BoardHydra. Sign in and choose **Connect**.
3. Obsidian opens again and finishes. If it doesn't, copy the code from the page into **Paste code**.
4. Choose the boards to sync.

Disconnect any time in the plugin settings, or on the website under Account → Integrations.

## What you get
```
BoardHydra/
  My board.md            ← Kanban note (works with the Kanban plugin)
  My board/
    Fix login.md         ← one note per card
    _archive/            ← cards archived in BoardHydra
    _conflicts/          ← your version, when both sides changed a card at once
```

A card note:
```markdown
---
bh_id: 6f1c…            # don't edit
bh_board: 2a9e…
bh_updated: 2026-11-17T10:00:00Z
list: To do
labels: [Bug]
members: [Sam Lee]
start: 
due: 2026-11-21T17:00:00Z
done: false
---
The description, in Markdown.

## Checklist: Steps
- [x] one
- [ ] two
  - [ ] a sub-item

## Links
- [Example](https://example.com)
```

- **Edit a note**: the card updates in BoardHydra about 2 seconds after you stop typing.
- **Rename the file**: the card is renamed.
- **Change `list:`**, or drag a card in the Kanban note: the card moves.
- **New note in a board folder**: a new card in the `list:` you give (or the first list).
- **Delete a note**: the card is archived in BoardHydra, never deleted. Restore it from the board's archive.
- **Changes in BoardHydra** show up live.
- **Both changed at once**: the note shows the BoardHydra version, and yours is saved in `_conflicts/`.

Lists, labels and members are made in BoardHydra. A name in the note that doesn't exist on the board is skipped, with a notice.

## Requests
Sync uses your plan's API requests: one per board when Obsidian starts, one per change you make. Live updates are free.
Pro includes 500 requests a day.

## Privacy
The plugin talks only to BoardHydra (`boardhydra.com`). Its key is stored in this vault's plugin settings
(`.obsidian/plugins/boardhydra/data.json`). Treat that file like a password, and leave it out of public vault backups.

## Develop
```
npm install
npm run dev      # rebuilds main.js on change
npm test         # note format tests
npm run build    # type-check + production bundle
```
Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/boardhydra/` to try it.
Set **Server** in the settings to a local BoardHydra (`http://localhost:8080`) for testing.

## Release
1. Bump `version` in `manifest.json` and `package.json`, and add it to `versions.json`.
2. `npm run build`, then make a GitHub release whose tag is the version (no `v`), with `main.js`, `manifest.json` and `styles.css` attached.
3. First release only: open a PR to `obsidianmd/obsidian-releases` that adds the plugin to `community-plugins.json`.
