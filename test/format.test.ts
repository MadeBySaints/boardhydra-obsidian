import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parse, stringify } from 'yaml'
import { noteToPatch, parseIndex, parseNote, posBetween, renderCard, renderIndex, safeName } from '../src/format'
import type { BHCard } from '../src/types'

const yaml = { parse: (s: string) => parse(s), stringify: (o: any) => stringify(o) }
let n = 0
const genId = () => 'new' + ++n

const ctx = {
  lists: [
    { id: 'l1', idBoard: 'b', name: 'To do', pos: 65536, closed: false },
    { id: 'l2', idBoard: 'b', name: 'Done', pos: 131072, closed: false },
  ],
  labels: [{ id: 'g', idBoard: 'b', name: 'Bug', color: 'red', pos: 1 }],
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

test('edits become a patch', () => {
  let text = renderCard(card, ctx, yaml)
  text = text.replace('Some **notes**', 'New text').replace('- [ ] two', '- [x] two').replace('list: To do', 'list: done')
  text = text.replace('labels:\n  - Bug', 'labels:\n  - Bug\n  - Nope')
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
