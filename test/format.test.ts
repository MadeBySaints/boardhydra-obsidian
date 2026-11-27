import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parse, stringify } from 'yaml'
import { LABEL_COLORS, checklistNotes, labelTag, listRequestName, newLabels, noteToPatch, pickLabelColor, parseIndex, parseNote, posBetween, renderBoardNote, renderCard, renderGuideNote, renderIndex, renderListNote, safeName, unlink, holdPinned, planIndexMoves, splitPatch } from '../src/format'
import type { BHCard } from '../src/types'

const yaml = { parse: (s: string) => parse(s), stringify: (o: any) => stringify(o) }
let n = 0
const genId = () => 'new' + ++n

const ctx = {
  lists: [
    { id: 'l1', idBoard: 'b', name: 'To do', pos: 65536, closed: false },
    { id: 'l2', idBoard: 'b', name: 'Done', pos: 131072, closed: false },
  ],
  labels: [{ id: 'g', idBoard: 'b', name: 'Bug', color: 'red', pos: 1 }, { id: 'h', idBoard: 'b', name: 'High priority', color: 'orange', pos: 2 }],
  members: [{ id: 'u1', fullName: 'Sam Lee', username: 'sam' }],
}

const card: BHCard = {
  id: 'c1', idBoard: 'b', idList: 'l1', name: 'Fix: login', desc: 'Some **notes**', pos: 65536, closed: false,
  idLabels: ['g'], idMembers: ['u1'], start: null, due: '2026-11-21T17:00:00Z', dueComplete: false,
  checklists: [{ id: 'k1', idCard: 'c1', name: 'Steps', checkItems: [
    { id: 'i1', name: 'one', state: 'complete', pos: 1 },
    { id: 'i2', name: 'two', state: 'incomplete', pos: 2, children: [{ id: 'i3', name: 'sub', state: 'incomplete', pos: 1 }] },
  ] }],
  links: [{ id: 'k', url: 'https://example.com', title: 'Example' }],
  dateLastActivity: '2026-11-17T10:00:00Z',
}

test('safe file names', () => {
  assert.equal(safeName('Fix: login'), 'Fix- login')
  assert.equal(safeName('  '), 'Untitled')
  assert.equal(safeName('a/b\\c#[x]'), 'a-b-c--x-')
})

test('a rendered card parses back to no changes', () => {
  const text = renderCard(card, ctx, yaml)
  assert.match(text, /^---\nbh_id: c1/)
  assert.match(text, /## Checklist: Steps\n- \[x\] one\n- \[ \] two\n {2}- \[ \] sub/)
  const parsed = parseNote(text, yaml)
  const { patch, warnings } = noteToPatch(parsed, safeName(card.name), card, ctx, genId)
  assert.deepEqual(patch, {})
  assert.deepEqual(warnings, [])
})

test('a Markdown description round-trips unchanged', () => {
  const desc = '# Plan\n\n**Bold**, *italic*, `code` and [a link](https://example.com).\n\n- one\n  - nested\n- [ ] a task\n- [x] done task\n1. first\n\n> quote\n\n```js\nconst x = 1 // ## Links\n```\n\n---\n## Notes heading'
  const md = { ...card, desc }
  const text = renderCard(md, ctx, yaml)
  const parsed = parseNote(text, yaml)
  assert.equal(parsed.desc, desc)
  assert.equal(parsed.checklists.length, 1) // the desc's task list is not taken for a checklist
  assert.deepEqual(noteToPatch(parsed, safeName(md.name), md, ctx, genId).patch, {})
})

test('edits become a patch', () => {
  let text = renderCard(card, ctx, yaml)
  text = text.replace('Some **notes**', 'New text').replace('- [ ] two', '- [x] two').replace('list: To do', 'list: done')
  text = text.replace('tags:\n  - bh/Bug', 'tags:\n  - bh/Bug\n  - bh/Nope\n  - my-own-tag')
  text += '- [Other](https://example.org)\n'
  const { patch, warnings } = noteToPatch(parseNote(text, yaml), safeName(card.name), card, ctx, genId)
  assert.equal(patch.desc, 'New text')
  assert.equal(patch.idList, 'l2')
  assert.equal(patch.idLabels, undefined) // unknown label is dropped, the rest is unchanged
  assert.equal(warnings.length, 1)
  assert.equal(patch.checklists![0].checkItems[1].state, 'complete')
  assert.equal(patch.checklists![0].checkItems[1].id, 'i2') // ids are kept
  assert.equal(patch.checklists![0].checkItems[1].children![0].id, 'i3')
  assert.equal(patch.links!.length, 2)
  assert.equal(patch.links![0].id, 'k')
})

test('renaming the file renames the card', () => {
  const text = renderCard(card, ctx, yaml)
  const { patch } = noteToPatch(parseNote(text, yaml), 'Login is fixed', card, ctx, genId)
  assert.equal(patch.name, 'Login is fixed')
})

test('dates in other spellings are not changes', () => {
  const text = renderCard(card, ctx, yaml).replace('due: 2026-11-21T17:00:00Z', 'due: 2026-11-21T17:00:00.000Z')
  assert.deepEqual(noteToPatch(parseNote(text, yaml), safeName(card.name), card, ctx, genId).patch, {})
})

test('a new note sets every field', () => {
  const text = '---\nlist: Done\ndue: 2026-12-01\n---\nHello\n\n## Checklist: A\n- [ ] x\n'
  const { patch } = noteToPatch(parseNote(text, yaml), 'New card', null, ctx, genId)
  assert.equal(patch.name, 'New card')
  assert.equal(patch.idList, 'l2')
  assert.equal(patch.desc, 'Hello')
  assert.equal(patch.due, '2026-12-01')
  assert.equal(patch.checklists!.length, 1)
})

test('board index round trip', () => {
  const second = { ...card, id: 'c2', name: 'Second', idList: 'l2', dueComplete: true }
  const text = renderIndex('b', ctx.lists, [card, second], (c) => 'BoardHydra/B/' + safeName(c.name))
  assert.match(text, /kanban-plugin: board/)
  assert.deepEqual(parseIndex(text), [
    { list: 'To do', targets: ['BoardHydra/B/Fix- login'] },
    { list: 'Done', targets: ['BoardHydra/B/Second'] },
  ])
})

test('positions between neighbours', () => {
  assert.equal(posBetween(undefined, undefined), 65536)
  assert.equal(posBetween(100, 200), 150)
  assert.equal(posBetween(undefined, 100), 50)
  assert.equal(posBetween(100, undefined), 65636)
})

const linked = { ...ctx, listLink: (l: { name: string }) => `[[BoardHydra/B/Lists/${l.name}|${l.name}]]` }

test('labels are bh/ tags, members and the list are links', () => {
  const text = renderCard(card, linked, yaml)
  assert.match(text, /tags:\n {2}- bh\/Bug\n/)
  assert.match(text, /members:\n {2}- "\[\[Sam Lee\]\]"/)
  assert.match(text, /list: "\[\[BoardHydra\/B\/Lists\/To do\|To do\]\]"/)
  assert.deepEqual(noteToPatch(parseNote(text, yaml), safeName(card.name), card, linked, genId).patch, {})
  assert.equal(labelTag(ctx.labels[1]), 'bh/High-priority')
})

test('tags and links edited in Obsidian', () => {
  let text = renderCard(card, linked, yaml)
  text = text.replace('  - bh/Bug', '  - "#bh/high-priority"').replace('list: "[[BoardHydra/B/Lists/To do|To do]]"', 'list: [[BoardHydra/B/Lists/Done|Done]]')
  text = text.replace('  - "[[Sam Lee]]"', '  - "[[People/sam|sam]]"')
  const { patch, warnings } = noteToPatch(parseNote(text, yaml), safeName(card.name), card, linked, genId)
  assert.deepEqual(patch.idLabels, ['h'])
  assert.equal(patch.idList, 'l2') // unquoted link: YAML reads it as a nested list
  assert.equal(patch.idMembers, undefined) // same member, by username
  assert.deepEqual(warnings, [])
})

test("the user's own tags and properties survive a sync", () => {
  const first = renderCard(card, linked, yaml)
  const mine = first.replace('  - bh/Bug', '  - bh/Bug\n  - idea').replace('done: false', 'done: false\nrating: 5')
  const again = renderCard({ ...card, idLabels: [] }, linked, yaml, parseNote(mine, yaml).fm)
  const fm = parseNote(again, yaml).fm
  assert.deepEqual(fm.tags, ['idea'])
  assert.equal(fm.rating, 5)
})

test('0.1.0 notes with labels: still work', () => {
  const old = renderCard(card, ctx, yaml).replace(/tags:\n {2}- bh\/Bug\n/, 'labels:\n  - Bug\n')
  assert.deepEqual(noteToPatch(parseNote(old, yaml), safeName(card.name), card, ctx, genId).patch, {})
})

test('unlink', () => {
  assert.equal(unlink('[[a/b/To do|To do]]'), 'To do')
  assert.equal(unlink('[[a/b/Done]]'), 'Done')
  assert.equal(unlink(' plain '), 'plain')
})

test('the AI guide note links up to its board and is marked as a guide', () => {
  const g = renderGuideNote('b', '[[BoardHydra/B|B]]', '# B — guide for AI\n\n## Lists\n')
  assert.match(g, /^---\nbh_board: b\nbh_kind: guide\n---\nBoard: \[\[BoardHydra\/B\|B\]\]\n\n# B — guide for AI/)
  assert.doesNotMatch(g, /bh_id|list:/) // never read as a card
})

test('board and list notes link down the tree', () => {
  const b = renderBoardNote('b', 'B', '', [{ link: '[[BoardHydra/B/Lists/To do|To do]]' }])
  assert.match(b, /## Lists\n- \[\[BoardHydra\/B\/Lists\/To do\|To do\]\]/)
  const l = renderListNote('b', ctx.lists[0], '[[BoardHydra/B|B]]', [{ link: '[[BoardHydra/B/Fix- login|Fix: login]]', done: false }])
  assert.match(l, /Board: \[\[BoardHydra\/B\|B\]\]/)
  assert.match(l, /- \[ \] \[\[BoardHydra\/B\/Fix- login\|Fix: login\]\]/)
})

test('card notes: one file per note, linked to card and author', async () => {
  const { renderCardNote, parseCardNote, noteFileName, linkTarget } = await import('../src/format')
  const n = { id: 'n1', idBoard: 'b', idCard: 'c1', idMember: 'u1', memberName: 'Sam Lee', body: 'Called the supplier.\nFriday works.', createdAt: '2026-11-17T14:38:00Z', updatedAt: '2026-11-17T14:38:00Z' }
  const text = renderCardNote(n, '[[BoardHydra/B/Fix- login|Fix: login]]', '[[Sam Lee]]', yaml, { mood: 'good', card: 'old' })
  const p = parseCardNote(text, yaml)
  assert.equal(p.fm.bh_note, 'n1')
  assert.equal(p.fm.card, '[[BoardHydra/B/Fix- login|Fix: login]]')
  assert.equal(p.fm.author, '[[Sam Lee]]')
  assert.equal(p.fm.mood, 'good') // the user's own property is kept; ours is replaced
  assert.equal(p.body, 'Called the supplier.\nFriday works.')
  assert.match(noteFileName(n, 'Fix: login'), /^Sam Lee – Fix- login \(2026-11-1\d \d\d\.\d\d\)$/)
  assert.equal(linkTarget('[[BoardHydra/B/Fix- login|Fix: login]]'), 'BoardHydra/B/Fix- login')
  assert.equal(linkTarget([['BoardHydra/B/X']]), 'BoardHydra/B/X')
})

test('checklist notes: card -> checklist -> items -> sub-items', () => {
  const files = checklistNotes(card, 'B/Checklists/Fix- login', '[[B/Fix- login|Fix: login]]', yaml)
  const by = new Map(files.map((f) => [f.path, f.text]))
  assert.deepEqual([...by.keys()].sort(), [
    'B/Checklists/Fix- login/Steps.md',
    'B/Checklists/Fix- login/Steps/one.md',
    'B/Checklists/Fix- login/Steps/two.md',
    'B/Checklists/Fix- login/Steps/two/sub.md',
  ])
  const cl = parse(by.get('B/Checklists/Fix- login/Steps.md')!.split('---')[1])
  assert.equal(cl.bh_kind, 'checklist')
  assert.equal(cl.card, '[[B/Fix- login|Fix: login]]')
  assert.equal(cl.progress, '1/3')
  assert.equal(cl.done, false)
  assert.match(by.get('B/Checklists/Fix- login/Steps.md')!, /- \[x\] \[\[B\/Checklists\/Fix- login\/Steps\/one\|one\]\]/)
  const sub = parse(by.get('B/Checklists/Fix- login/Steps/two/sub.md')!.split('---')[1])
  assert.equal(sub.parent, '[[B/Checklists/Fix- login/Steps/two|two]]')
  assert.equal(sub.bh_kind, 'checkitem')
  assert.equal(parse(by.get('B/Checklists/Fix- login/Steps/one.md')!.split('---')[1]).done, true)
  assert.match(by.get('B/Checklists/Fix- login/Steps/two.md')!, /## Sub-items\n- \[ \] \[\[B\/Checklists\/Fix- login\/Steps\/two\/sub\|sub\]\]/)
})

test('checklist notes: same names get their own files', () => {
  const c: BHCard = { ...card, checklists: [
    { id: 'a', idCard: 'c1', name: 'QA', checkItems: [{ id: 'x', name: 'Test', state: 'incomplete', pos: 1 }, { id: 'y', name: 'test', state: 'incomplete', pos: 2 }] },
    { id: 'b', idCard: 'c1', name: 'QA', checkItems: [] },
  ] }
  const paths = checklistNotes(c, 'D', '[[x]]', yaml).map((f) => f.path).sort()
  assert.deepEqual(paths, ['D/QA (2).md', 'D/QA.md', 'D/QA/Test.md', 'D/QA/test (2).md'])
})

// ---------- graph colors ----------
import { labelColorGroups, mergeColorGroups, withArchiveFilter } from '../src/graph'

test('graph groups: one per colored label, board order, first board wins a name', () => {
  const g = labelColorGroups([
    { id: '1', idBoard: 'b', name: 'High priority', color: 'lime', pos: 1, hex: '#a8e05b' },
    { id: '2', idBoard: 'b', name: 'Bug', color: 'red', pos: 2 }, // no hex: free color fallback
    { id: '3', idBoard: 'b', name: 'Plain', color: null, pos: 3 },
    { id: '4', idBoard: 'c', name: 'bug', color: 'blue', pos: 1, hex: '#3f9bff' },
  ])
  assert.deepEqual(g, [
    { query: 'tag:#bh/High-priority', color: { a: 1, rgb: 0xa8e05b } },
    { query: 'tag:#bh/Bug', color: { a: 1, rgb: 0xff5d6c } },
  ])
})

test('graph groups: yours are kept first, ours replaced', () => {
  const mine = { query: 'path:Daily', color: { a: 1, rgb: 1 } }
  const old = { query: 'tag:#bh/Gone', color: { a: 1, rgb: 2 } }
  const ours = [{ query: 'tag:#bh/Bug', color: { a: 1, rgb: 3 } }]
  assert.deepEqual(mergeColorGroups([old, mine, 'junk'], ours), [mine, ...ours])
  assert.deepEqual(mergeColorGroups(undefined, []), [])
})

test('graph groups: note types first, then labels, then plain cards; all of them ours', async () => {
  const { allColorGroups, KIND_GROUPS, CARD_GROUP } = await import('../src/graph')
  const all = allColorGroups([{ id: '1', idBoard: 'b', name: 'Bug', color: 'red', pos: 1 }])
  assert.equal(all[0].query, '[bh_kind:checkitem] [done:true]') // green beats red for finished items
  assert.deepEqual(all.map((g) => g.query).slice(KIND_GROUPS.length), ['tag:#bh/Bug', CARD_GROUP.query])
  const mine = { query: 'path:Daily', color: { a: 1, rgb: 1 } }
  assert.deepEqual(mergeColorGroups([...all, mine], []), [mine])
})

test('a restored card drops the archived flag but keeps the user own properties', () => {
  const text = renderCard(card, ctx, yaml, { archived: true, list: '[[x/_archive/Archived cards|Archived cards]]', mood: 'happy' })
  assert.doesNotMatch(text, /archived:/)
  assert.doesNotMatch(text, /Archived cards/)
  assert.match(text, /mood: happy/)
})

test('withArchiveFilter adds or removes only our term and keeps the rest of the graph filter', () => {
  assert.equal(withArchiveFilter('', true), '-path:_archive')
  assert.equal(withArchiveFilter(undefined, true), '-path:_archive')
  assert.equal(withArchiveFilter('tag:#work', true), 'tag:#work -path:_archive')
  assert.equal(withArchiveFilter('tag:#work -path:_archive', true), 'tag:#work -path:_archive')
  assert.equal(withArchiveFilter('-path:_archive tag:#work', false), 'tag:#work')
  assert.equal(withArchiveFilter('-path:_archived', false), '-path:_archived')
  assert.equal(withArchiveFilter('"two  spaces"', false), '"two  spaces"')
})

test('a list or label the board lacks is reported as missing, so the sync can make it', () => {
  const text = '---\nlist: "[[B/Lists/Blocked|Blocked]]"\ntags: [bh/Bug, bh/Urgent, bh/High-priority, mine]\n---\nx\n'
  const { patch, missing, warnings } = noteToPatch(parseNote(text, yaml), 'New card', null, ctx, genId)
  assert.equal(missing.list, 'Blocked')
  assert.deepEqual(missing.labels, [{ name: 'Urgent' }])
  assert.deepEqual(patch.idLabels, ['g', 'h'])
  assert.equal(warnings.length, 2)
  const ok = noteToPatch(parseNote('---\nlist: To do\ntags: [bh/Bug]\n---\n', yaml), 'C', null, ctx, genId)
  assert.deepEqual(ok.missing, { labels: [] })
})

test('new_labels gives a missing label its name and color; the tag still matches it', () => {
  const text = '---\ntags: [bh/Needs-review]\nnew_labels:\n  - { name: Needs review, color: Sky }\n  - Unused\n---\n'
  const { missing } = noteToPatch(parseNote(text, yaml), 'C', null, ctx, genId)
  assert.deepEqual(missing.labels, [{ name: 'Needs review', color: 'sky' }])
  assert.equal(labelTag({ id: 'x', idBoard: 'b', name: 'Needs review', color: 'sky', pos: 1 }), 'bh/Needs-review')
  assert.deepEqual(newLabels({ 'A b': 'red', C: null }), [{ name: 'A b', color: 'red' }, { name: 'C' }])
  assert.deepEqual(newLabels(undefined), [])
})

test('new_labels is dropped when the card note is written again', () => {
  const text = renderCard(card, ctx, yaml, { new_labels: [{ name: 'X', color: 'red' }], mood: 'happy' })
  assert.doesNotMatch(text, /new_labels/)
  assert.match(text, /mood: happy/)
})

test('a new label gets a free color the board doesn’t use yet', () => {
  assert.equal(pickLabelColor([]), 'green')
  assert.equal(pickLabelColor(ctx.labels), 'green')
  const all = LABEL_COLORS.map((c, i) => ({ id: c, idBoard: 'b', name: c, color: c, pos: i }))
  assert.equal(pickLabelColor(all), 'green')
  assert.equal(pickLabelColor(all.slice(0, 3)), 'red')
})

// ---------- pinned cards ----------

const pinnedCard: BHCard = { ...card, pinned: true }

test('pinned is written only on a pinned card, and an unpinned card drops the property', () => {
  assert.doesNotMatch(renderCard(card, ctx, yaml), /pinned/)
  const text = renderCard(pinnedCard, ctx, yaml)
  assert.match(text, /pinned: true\n/)
  assert.deepEqual(noteToPatch(parseNote(text, yaml), safeName(card.name), pinnedCard, ctx, genId).patch, {})
  assert.doesNotMatch(renderCard(card, ctx, yaml, parseNote(text, yaml).fm), /pinned/)
})

test('only an explicit pinned true or false changes the pin', () => {
  const patch = (line: string, c: BHCard | null) => noteToPatch(parseNote(`---\n${line}\n---\n`, yaml), 'C', c, ctx, genId).patch.pinned
  assert.equal(patch('pinned: true', card), true)
  assert.equal(patch('pinned: "true"', card), true)
  assert.equal(patch('pinned: false', pinnedCard), false)
  assert.equal(patch('pinned: "false"', pinnedCard), false)
  assert.equal(patch('pinned: true', pinnedCard), undefined)
  assert.equal(patch('pinned: false', card), undefined)
  assert.equal(patch('done: false', pinnedCard), undefined) // missing: a note written by 0.3.10
  assert.equal(patch('pinned:', pinnedCard), undefined)
  assert.equal(patch('pinned: yes please', card), undefined)
  assert.equal(patch('pinned: true', null), true)
  assert.equal(patch('pinned: false', null), undefined)
})

const at = (id: string, pos: number, more: Partial<BHCard> = {}): BHCard => ({ ...card, id, name: id, pos, ...more })
const byName = (...cards: BHCard[]) => new Map(cards.map((c) => [c.name, c]))
const unticked = (cards: Map<string, BHCard>) => new Map([...cards.keys()].map((t) => [t, false]))

test('the Kanban note shows pinned cards first', () => {
  const text = renderIndex('b', ctx.lists, [at('a', 1), at('p', 900, { pinned: true }), at('b', 2)], (c) => c.name)
  assert.deepEqual(parseIndex(text)[0].targets, ['p', 'a', 'b'])
})

test('an untouched Kanban note with a pin far down the list moves nothing', () => {
  const all = byName(at('p', 900, { pinned: true }), at('a', 1), at('b', 2))
  const out = planIndexMoves(ctx.lists, [{ list: 'To do', targets: ['p', 'a', 'b'] }], all, unticked(all))
  assert.deepEqual(out, { moves: [], held: [] })
})

test('a pinned card dragged to another list stays, its tick is still sent, and other cards move', () => {
  const all = byName(at('p', 900, { pinned: true }), at('a', 1), at('d', 50, { idList: 'l2' }))
  const checked = unticked(all).set('p', true)
  const out = planIndexMoves(ctx.lists, [{ list: 'To do', targets: [] }, { list: 'Done', targets: ['d', 'p', 'a'] }], all, checked)
  assert.deepEqual(out.held, ['p'])
  assert.deepEqual(out.moves, [
    { id: 'p', patch: { dueComplete: true } },
    { id: 'a', patch: { idList: 'l2', pos: 50 + 65536 } },
  ])
})

test('a card dragged above a pin gets a position among the unpinned cards', () => {
  const all = byName(at('p', 900, { pinned: true }), at('a', 100), at('b', 200))
  const out = planIndexMoves(ctx.lists, [{ list: 'To do', targets: ['b', 'p', 'a'] }], all, unticked(all))
  assert.equal(out.moves.length, 1)
  assert.equal(out.moves[0].id, 'b')
  assert.equal(out.moves[0].patch.pos, 50)
  assert.deepEqual(planIndexMoves(ctx.lists, [{ list: 'To do', targets: ['a', 'p', 'b'] }], all, unticked(all)).moves, [])
})

test('a refused patch is split into the parts that can be refused on their own', () => {
  assert.deepEqual(splitPatch({ name: 'n', idList: 'l2', pos: 5, pinned: true, dueComplete: true, desc: 'd', ifUpdatedAt: 't' }),
    [{ name: 'n', desc: 'd' }, { dueComplete: true }, { idList: 'l2', pos: 5 }, { pinned: true }])
  assert.deepEqual(splitPatch({ pinned: false, idList: 'l2' }), [{ pinned: false, idList: 'l2' }]) // must travel together
  assert.deepEqual(splitPatch({ pinned: true }), [{ pinned: true }])
  assert.deepEqual(splitPatch({}), [])
})

test('a pinned card is held in its list unless the note unpins it', () => {
  const read = (fm: string, c: BHCard) => holdPinned(noteToPatch(parseNote(`---\n${fm}\n---\nNew text\n`, yaml), safeName(c.name), c, ctx, genId), c)
  const held = read('list: Done', pinnedCard)
  assert.equal(held.held, true)
  assert.equal(held.patch.idList, undefined)
  assert.equal(held.patch.desc, 'New text') // the rest of the edit still goes
  const unpinned = read('list: Done\npinned: false', pinnedCard)
  assert.equal(unpinned.held, false)
  assert.equal(unpinned.patch.idList, 'l2')
  assert.equal(unpinned.patch.pinned, false)
  assert.equal(read('list: Done', card).patch.idList, 'l2')
  assert.equal(read('list: To do', pinnedCard).held, false)
  const newList = read('list: Review', pinnedCard) // no empty list is made for a card that can't move there
  assert.equal(newList.held, true)
  assert.equal(newList.missing.list, undefined)
  assert.deepEqual(newList.warnings, [])
  assert.equal(read('list: Review', card).missing.list, 'Review')
})

test('which notes in Lists/ ask for a new list', () => {
  assert.equal(listRequestName('# Review\n', 'Review', yaml), 'Review')
  assert.equal(listRequestName('---\nname: "Q3: plans"\n---\n', 'Q3- plans', yaml), 'Q3: plans')
  assert.equal(listRequestName('', 'Review', yaml), null)
  assert.equal(listRequestName('x', 'Untitled 2', yaml), null)
  assert.equal(listRequestName('x', '_mine', yaml), null)
  assert.equal(listRequestName(renderListNote('b', ctx.lists[0], '[[B]]', []), 'To do', yaml), null)
})
