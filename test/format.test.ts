import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parse, stringify } from 'yaml'
import { checklistNotes, labelTag, noteToPatch, parseIndex, parseNote, posBetween, renderBoardNote, renderCard, renderIndex, renderListNote, safeName, unlink } from '../src/format'
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
