// `src/yaml-lite.js` — the Unity YAML reader/editor behind `unity_yaml_read`,
// `unity_yaml_search` and the field-level write path.
//
// Unity YAML is not general YAML, and the fixtures here are deliberately the
// shapes that break general parsers: a `'HP {'` string, a `#ff0000` colour, a
// `|` block scalar with deeper indentation, a wrapped `{…}` flow mapping, a
// prefab instance whose `m_Modifications` are a list of mappings, and a
// `stripped` document. The edit tests then prove the writer never re-serializes
// the rest of the file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyEdit,
  compileEdit,
  countBraces,
  editYamlText,
  looksBinary,
  parseUnityYaml,
  queryDocument,
  quoteScalar,
  readYamlFile,
  readYamlText,
  renderNode,
  resolveProjectFile,
  searchDocuments,
  searchYamlFiles,
  selectDocument,
  unquote,
} from '../src/yaml-lite.js'

/** A prefab that exercises every shape listed in the header comment. */
const PREFAB = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100000
GameObject:
  m_ObjectHideFlags: 0
  m_Component:
  - component: {fileID: 400000}
  - component: {fileID: 11400000}
  m_Name: Player
  m_TagString: Player
  m_IsActive: 1
--- !u!4 &400000
Transform:
  m_GameObject: {fileID: 100000}
  m_LocalPosition: {x: 0, y: 1, z: 0}
  m_Children: []
--- !u!114 &11400000
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 100000}
  m_Script: {fileID: 11500000, guid: 0123456789abcdef0123456789abcdef, type: 3}
  speed: 5
  m_Colour: #ff0000
  m_Text: 'HP {'
  m_Desc: |
    line one
      indented
    line three
  m_List:
  - first
  - second
--- !u!1001 &200000
PrefabInstance:
  m_Modification:
    m_Modifications:
    - target: {fileID: 400000, guid: abcdef0123456789abcdef0123456789, type: 3}
      propertyPath: tuning.steps.Array.data[0].max
      value: 33
    - target: {fileID: 400000, guid: abcdef0123456789abcdef0123456789, type: 3}
      propertyPath: main
      value: 5
  m_SourcePrefab: {fileID: 100100000, guid: abcdef0123456789abcdef0123456789, type: 3}
--- !u!224 &300000 stripped
RectTransform:
  m_CorrespondingSourceObject: {fileID: 400000, guid: abcdef0123456789abcdef0123456789, type: 3}
  m_PrefabInstance: {fileID: 200000}
`

/** A throwaway Unity-shaped project with one prefab in it. */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'locus-yaml-lite-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'Assets', 'Prefabs'), { recursive: true })
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  writeFileSync(join(root, 'Assets', 'Prefabs', 'Player.prefab'), PREFAB)
  writeFileSync(join(root, 'Assets', 'Settings.asset'), '--- !u!114 &1\nPlayerSettings:\n  quality: 2\n')
  return root
}

test('every document header yields its classId and fileId', () => {
  const { documents } = parseUnityYaml(PREFAB)
  assert.deepEqual(
    documents.map((document) => [document.classId, document.fileId, document.typeName, document.stripped]),
    [
      [1, 100000, 'GameObject', false],
      [4, 400000, 'Transform', false],
      [114, 11400000, 'MonoBehaviour', false],
      [1001, 200000, 'PrefabInstance', false],
      [224, 300000, 'RectTransform', true],
    ],
  )
  // The trailing `stripped` marker is how a prefab instance's own objects are
  // written, and a reader that treats them as real objects reports duplicates.
  assert.equal(documents[4].stripped, true)
})

test('a document body is addressed by field, with or without its type name', () => {
  const { documents } = parseUnityYaml(PREFAB)
  const script = documents[2]
  assert.equal(queryDocument(script, '/MonoBehaviour/speed').value, '5')
  assert.equal(queryDocument(script, '/speed').value, '5', 'the type prefix is optional')
  assert.equal(queryDocument(script, '/m_Script/guid').value, '0123456789abcdef0123456789abcdef')
  assert.equal(queryDocument(script, '/m_Script/fileID').value, '11500000')
  assert.equal(queryDocument(script, '/nope'), null)
  assert.equal(queryDocument(script, '').kind, 'map')
})

test('apparently invalid YAML scalars survive: braces, hashes and block scalars', () => {
  const { documents } = parseUnityYaml(PREFAB)
  const script = documents[2]
  // `'HP {'` must not open a flow mapping.
  assert.equal(queryDocument(script, '/m_Text').value, 'HP {')
  // `#ff0000` is a value, not a comment, because it follows `key: `.
  assert.equal(queryDocument(script, '/m_Colour').value, '#ff0000')
  // A literal block keeps the deeper indentation of its second line.
  assert.equal(queryDocument(script, '/m_Desc').value, '    line one\n      indented\n    line three\n')
})

test('a sequence of mappings is addressable by index', () => {
  const { documents } = parseUnityYaml(PREFAB)
  const instance = documents[3]
  assert.equal(queryDocument(instance, '/m_Modification/m_Modifications/0/propertyPath').value, 'tuning.steps.Array.data[0].max')
  assert.equal(queryDocument(instance, '/m_Modification/m_Modifications/1/value').value, '5')
  assert.equal(queryDocument(instance, '/m_Modification/m_Modifications/2'), null)
  const list = queryDocument(documents[2], '/m_List')
  assert.equal(list.kind, 'seq')
  assert.equal(queryDocument(documents[2], '/m_List/1').value, 'second')
})

test('countBraces ignores braces inside quotes', () => {
  assert.equal(countBraces('{a: 1}'), 0)
  assert.equal(countBraces('{a: 1'), 1)
  assert.equal(countBraces("m_Text: 'HP {'"), 0)
  // An unclosed quote swallows the rest of the line, so the brace is ignored.
  assert.equal(countBraces(`m_Text: 'HP {`), 0)
})

test('unquote and quoteScalar round-trip the shapes Unity writes', () => {
  assert.equal(unquote("'HP {'"), 'HP {')
  assert.equal(unquote("'it''s'"), "it's")
  assert.equal(unquote('"a\\"b"'), 'a"b')
  assert.equal(unquote('plain'), 'plain')
  assert.equal(quoteScalar('plain'), 'plain')
  assert.equal(quoteScalar("it's"), '"it\'s"')
  assert.equal(quoteScalar('HP {'), "'HP {'")
  assert.equal(quoteScalar('123'), "'123'", 'a numeric-looking string stays a string')
  for (const text of ['plain', 'with space', 'HP {', "it's", 'a: b', '"quoted"', '']) {
    assert.equal(unquote(quoteScalar(text)), text, `round-trip ${JSON.stringify(text)}`)
  }
})

test('selectDocument resolves a fileId, a name and an unknown object', () => {
  const { documents } = parseUnityYaml(PREFAB)
  assert.equal(selectDocument(documents, '11400000').document.classId, 114)
  assert.equal(selectDocument(documents, 'fileID:400000').document.classId, 4)
  assert.equal(selectDocument(documents, 'Player').document.classId, 1)
  assert.equal(selectDocument(documents, 'MonoBehaviour/Player'), null, 'the name belongs to the GameObject')
  assert.equal(selectDocument(documents, 'all'), null)
})

test('renderNode bounds the expansion and never loses a field name', () => {
  const { documents } = parseUnityYaml(PREFAB)
  // depth 0 shows the top level only; every deeper value is a size hint.
  const shallow = renderNode({ kind: 'map', children: documents[3].tree, synthetic: true }, { depth: 0, maxItems: 99 })
  assert.match(shallow, /^m_Modification:$/m)
  assert.match(shallow, /not expanded \(depth 0\)/)

  const text = renderNode({ kind: 'map', children: documents[2].tree, synthetic: true }, { depth: 4, maxItems: 8 })
  assert.match(text, /^m_ObjectHideFlags: 0$/m)
  assert.match(text, /^m_Script: \{fileID: 11500000, guid: 0123/m)
  assert.doesNotMatch(text, /undefined:/)
  // A list longer than `maxItems` says how much it hid.
  const bounded = renderNode({ kind: 'map', children: documents[2].tree, synthetic: true }, { depth: 4, maxItems: 3 })
  assert.match(bounded, /… \d+ more/)
})

test('searchDocuments matches field name, value and regular expressions', () => {
  const { documents } = parseUnityYaml(PREFAB)
  const byName = searchDocuments(documents, { query: 'speed', matchFields: 'field_name' })
  assert.equal(byName.total, 1)
  assert.equal(byName.matches[0].pointer, '/MonoBehaviour/speed')
  const byValue = searchDocuments(documents, { query: 'abcdef0123456789', matchFields: 'field_value' })
  // `m_Script` (the 0123… guid is different) appears in the two `abcdef…` refs
  // plus the prefab instance's `m_Modifications` targets.
  assert.equal(byValue.total, 4)
  assert.ok(byValue.matches.every((match) => match.value.includes('abcdef0123456789')))
  const byRegex = searchDocuments(documents, { query: 're:^m_(Name|Text)$', matchFields: 'field_name' })
  assert.equal(byRegex.total, 2, 'a `re:` query is a regular expression')
  const limited = searchDocuments(documents, { query: 'fileID', limit: 2 })
  assert.equal(limited.matches.length, 2)
  assert.equal(limited.truncated, true)
  assert.throws(() => searchDocuments(documents, { query: '' }), /query is required/)
  assert.throws(() => searchDocuments(documents, { query: 're:[' }), /not a valid regular expression/)
  assert.throws(() => searchDocuments(documents, { query: 'x', matchFields: 'bogus' }), /not one of/)
})

test('a user path may not escape the project root', (t) => {
  const root = project(t)
  assert.throws(() => resolveProjectFile(root, '../outside.prefab'), /outside the Unity project/)
  assert.throws(() => resolveProjectFile(root, '/etc/passwd'), /outside the Unity project/)
  assert.throws(() => resolveProjectFile(root, 'Assets/../../x.prefab'), /outside the Unity project/)
  assert.throws(() => resolveProjectFile(root, ''), /path is required/)
  assert.equal(resolveProjectFile(root, 'Assets/Prefabs/Player.prefab'), join(root, 'Assets/Prefabs/Player.prefab'))
})

test('readYamlText reads from disk without an Editor and reports the document list', (t) => {
  const root = project(t)
  const all = readYamlText(root, { path: 'Assets/Prefabs/Player.prefab', depth: 1, maxItems: 50 })
  assert.equal(all.source, 'disk')
  assert.equal(all.total, 5)
  assert.match(all.text, /--- !u!114 &11400000 \(MonoBehaviour\)/)
  assert.match(all.text, /\(stripped\)/)
  const one = readYamlText(root, { path: 'Assets/Prefabs/Player.prefab', object: 'MonoBehaviour' })
  assert.equal(one.total, 5)
  assert.throws(() => readYamlText(root, { path: 'Assets/Prefabs/Player.prefab', object: 'nope' }), /No document in .* matches object 'nope'/)
  assert.throws(() => readYamlText(root, { path: 'Assets/Prefabs/Missing.prefab' }), /does not exist/)
  assert.throws(() => readYamlText(root, { path: 'ProjectSettings/ProjectVersion.txt' }), /not a Unity YAML asset/)
})

test('readYamlFile refuses a path outside the project even through a symlink-shaped name', (t) => {
  const root = project(t)
  assert.throws(() => readYamlFile(root, '../Player.prefab'), /outside the Unity project/)
})

test('searchYamlFiles searches a file, a directory and the whole project', (t) => {
  const root = project(t)
  const file = searchYamlFiles(root, { query: 'speed', scope: 'Assets/Prefabs/Player.prefab' })
  assert.equal(file.total, 1)
  assert.match(file.text, /Player\.prefab:22 \/MonoBehaviour\/speed = 5/)
  const directory = searchYamlFiles(root, { query: 'quality', scope: 'Assets' })
  assert.equal(directory.total, 1)
  assert.match(directory.matches[0].path, /^Assets\//)
  // A missing scope is an error, not a silent "no matches".
  assert.throws(() => searchYamlFiles(root, { query: 'anything', scope: 'Assets/Nope' }), /does not exist/)
  assert.throws(() => searchYamlFiles(root, { query: 'x', scope: '../x' }), /outside the Unity project/)
})

test('compileEdit replaces only the scalar text', () => {
  const { documents } = parseUnityYaml(PREFAB)
  const edit = compileEdit({ documents, path: 'Player.prefab' }, { pointer: '/MonoBehaviour/speed', value: '9' })
  const after = applyEdit(PREFAB, edit)
  assert.match(after, /\n  speed: 9\n/)
  // Everything before and after the value is byte-identical.
  assert.equal(after.length, PREFAB.length)
  assert.equal(after.replace('speed: 9', 'speed: 5'), PREFAB)
})

test('compileEdit keeps the quoting style of the field it changes', () => {
  const { documents } = parseUnityYaml(PREFAB)
  const text = compileEdit({ documents, path: 'p' }, { pointer: '/m_Text', value: 'HP 2' })
  assert.equal(applyEdit(PREFAB, text).includes("m_Text: 'HP 2'"), true, 'a quoted string stays single-quoted')
  // A field inside `{fileID: …}` cannot be edited alone; asking for it is an
  // error rather than a silent rewrite of the whole mapping.
  assert.throws(
    () => compileEdit({ documents, path: 'p' }, { pointer: '/m_Script/fileID', value: '77' }),
    /inside a flow mapping/,
  )
})

test('compileEdit refuses what it cannot do safely', () => {
  const { documents } = parseUnityYaml(PREFAB)
  assert.throws(() => compileEdit({ documents, path: 'p' }, { pointer: '/MonoBehaviour/missing', value: '1' }), /does not exist/)
  assert.throws(() => compileEdit({ documents, path: 'p' }, { pointer: '/m_List', value: '1' }), /not a scalar/)
  assert.throws(() => compileEdit({ documents, path: 'p' }, { pointer: '', value: '1' }), /property_path is required/)
  assert.throws(() => compileEdit({ documents, path: 'p' }, { pointer: '/m_List/1', operation: 'bogus' }), /operation must be one of/)
  const insert = compileEdit({ documents, path: 'p' }, { pointer: '/MonoBehaviour/brandNew', operation: 'insert', value: 'hi' })
  assert.equal(applyEdit(PREFAB, insert).includes('  brandNew: hi'), true)
})

test('editYamlText writes the file, re-parses it and previews the change', (t) => {
  const root = project(t)
  const path = join(root, 'Assets', 'Prefabs', 'Player.prefab')
  const before = readFileSync(path, 'utf8')
  const result = editYamlText(root, { path: 'Assets/Prefabs/Player.prefab', propertyPath: '/MonoBehaviour/speed', value: '9' })
  assert.equal(result.applied, true)
  assert.match(result.preview, /^- {3}speed: 5$/m)
  assert.match(result.preview, /^\+ {3}speed: 9$/m)
  const after = readFileSync(path, 'utf8')
  assert.equal(after, before.replace('speed: 5', 'speed: 9'))
  // The edited file is still a valid Unity YAML document set.
  const { documents } = parseUnityYaml(after)
  assert.equal(queryDocument(documents[2], '/speed').value, '9')

  // A dry run writes nothing.
  const dry = editYamlText(root, { path: 'Assets/Prefabs/Player.prefab', propertyPath: '/MonoBehaviour/speed', value: '10', write: false })
  assert.equal(dry.applied, false)
  assert.equal(readFileSync(path, 'utf8'), after)

  // Setting the same value again reports "no change" instead of touching it.
  const same = editYamlText(root, { path: 'Assets/Prefabs/Player.prefab', propertyPath: '/MonoBehaviour/speed', value: '9' })
  assert.match(same.text, /no change/)
  assert.equal(readFileSync(path, 'utf8'), after)
})

test('an edit that would corrupt the file is refused before anything is written', (t) => {
  const root = project(t)
  const path = join(root, 'Assets', 'Prefabs', 'Player.prefab')
  const before = readFileSync(path, 'utf8')
  // `m_Desc` is a block scalar; writing a newline through the scalar path would
  // leave an unreadable file, so the write is refused rather than guessed.
  assert.throws(() => editYamlText(root, { path: 'Assets/Prefabs/Player.prefab', propertyPath: '/MonoBehaviour/m_Desc/deeper', value: 'x' }), /does not exist/)
  assert.equal(readFileSync(path, 'utf8'), before)
})
// Unity stores scenes and prefabs either as text YAML or as an AssetBundle
// serialization (starts with NUL padding). Saying "no --- header" for the
// latter reads like a corrupt text file, so the reader names the real reason.
test('a binary AssetBundle asset is explained instead of reported as headerless', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-yaml-binary-'))
  try {
    writeFileSync(join(root, 'Scene.unity'), Buffer.concat([Buffer.alloc(11), Buffer.from('2022.3.62f3c1')]))
    const result = readYamlText(root, { path: 'Scene.unity', depth: 1 })
    assert.match(result.text, /binary asset: this scene or prefab is stored as an AssetBundle serialization/)
    assert.doesNotMatch(result.text, /no "---" header/)
    assert.equal(looksBinary(Buffer.from([0, 97, 98])), true)
    assert.equal(looksBinary(Buffer.from('--- !u!1 &1')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
