// Local hot-reload classification: the file-level rules that used to live in the
// editor package. Fixtures are real scripts under a throwaway project.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyHotPaths,
  normalizeAssetPath,
  reflectionName,
  stripCommentsAndStrings,
} from '../src/hotreload-classify.js'

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'locus-classify-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'Assets', 'Scripts'), { recursive: true })
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  return root
}

function write(root, name, source, { meta = true } = {}) {
  const path = join(root, 'Assets', 'Scripts', name)
  writeFileSync(path, source)
  if (meta) writeFileSync(`${path}.meta`, '')
  return `Assets/Scripts/${name}`
}

test('a method body change is hot with Allman braces on their own line', (t) => {
  const root = project(t)
  const path = write(root, 'Player.cs', `namespace Game
{
    public class Player
    {
        public void Update()
        {
            int x = 1;
        }
    }
}
`)
  const result = classifyHotPaths(root, [path])
  assert.equal(result.files[0].state, 'hot')
  assert.equal(result.hot.length, 1)
  assert.equal(result.hot[0].method_key, 'Game.Player|Update||i')
  assert.equal(result.hot[0].declaring_type, 'Game.Player')
  assert.equal(result.hot[0].is_static, false)
  assert.equal(result.hot[0].is_ctor, false)
})

test('K&R braces produce the same identity', (t) => {
  const root = project(t)
  const path = write(root, 'K.cs', `public class K {
    public static int Value() { return 1; }
}
`)
  const result = classifyHotPaths(root, [path])
  assert.equal(result.hot.length, 1)
  assert.equal(result.hot[0].method_key, 'K|Value||s')
  assert.equal(result.hot[0].is_static, true)
})

test('parameter types use the reflection shape', (t) => {
  const root = project(t)
  const path = write(root, 'P.cs', `public class P
{
    public void Set(List<int> items, ref string name)
    {
    }
}
`)
  const result = classifyHotPaths(root, [path])
  assert.equal(result.hot.length, 1)
  assert.deepEqual(result.hot[0].param_type_names, ['List`1', 'String&'])
  assert.deepEqual(result.hot[0].param_type_sigs, ['List<int>', 'System.String&'])
  assert.equal(result.hot[0].method_key, 'P|Set|List`1,String&|i')
})

test('a constructor is a detour target named .ctor', (t) => {
  const root = project(t)
  const path = write(root, 'C.cs', `public class C
{
    public C(int value)
    {
    }
}
`)
  const result = classifyHotPaths(root, [path])
  assert.equal(result.hot.length, 1)
  assert.equal(result.hot[0].name, '.ctor')
  assert.equal(result.hot[0].is_ctor, true)
  assert.equal(result.hot[0].method_key, 'C|.ctor|Int32|i')
})

test('generic and expression-bodied methods are left to a real compile', (t) => {
  const root = project(t)
  const path = write(root, 'G.cs', `public class G
{
    public T Get<T>(T value)
    {
        return value;
    }

    public int Speed() => 1;
}
`)
  const result = classifyHotPaths(root, [path])
  // Nothing detourable, but the file itself is not structural: hot with no method.
  assert.equal(result.files[0].state, 'hot')
  assert.equal(result.hot.length, 0)
  assert.equal(result.files[0].method_count, 0)
})

test('a record forces a compile', (t) => {
  const root = project(t)
  const path = write(root, 'R.cs', 'public record R(int Value);\n')
  const result = classifyHotPaths(root, [path])
  assert.equal(result.needCompile.length, 1)
  assert.match(result.needCompile[0].reason, /record/)
})

test('an interface forces a compile', (t) => {
  const root = project(t)
  const path = write(root, 'I.cs', 'public interface I { void Tick(); }\n')
  const result = classifyHotPaths(root, [path])
  assert.match(result.needCompile[0].reason, /interface/)
})

test('an enum before any class forces a compile', (t) => {
  const root = project(t)
  const path = write(root, 'E.cs', 'public enum Mode { A, B }\n\npublic class Holder { }\n')
  const result = classifyHotPaths(root, [path])
  assert.match(result.needCompile[0].reason, /enum/)
})

test('a field at member position forces a compile', (t) => {
  const root = project(t)
  const path = write(root, 'F.cs', `public class F
{
    [SerializeField] private int hp = 3;

    public void Tick()
    {
    }
}
`)
  const result = classifyHotPaths(root, [path])
  assert.match(result.needCompile[0].reason, /field layout/)
})

test('a local variable inside a method is not a field', (t) => {
  const root = project(t)
  const path = write(root, 'L.cs', `public class L
{
    public void Tick()
    {
        int hp = 3;
        hp += 1;
    }
}
`)
  const result = classifyHotPaths(root, [path])
  assert.equal(result.files[0].state, 'hot')
  assert.equal(result.hot.length, 1)
})

test('a field-like event forces a compile', (t) => {
  const root = project(t)
  const path = write(root, 'V.cs', `public class V
{
    public event System.Action Changed;

    public void Tick()
    {
    }
}
`)
  const result = classifyHotPaths(root, [path])
  // The member-position scan treats `event` as the type name, so the verdict is
  // the same field-layout one upstream reaches for a field-like event.
  assert.match(result.needCompile[0].reason, /field layout|event/)
})

test('a type name declared by two scripts is cold in both', (t) => {
  const root = project(t)
  const a = write(root, 'A.cs', 'public class Shared { }\n')
  const b = write(root, 'B.cs', 'public class Shared { }\n')
  for (const path of [a, b]) {
    const result = classifyHotPaths(root, [path])
    assert.equal(result.needCompile.length, 1)
    assert.match(result.needCompile[0].reason, /same type name/)
  }
})

test('a file with no type declaration is hot without methods', (t) => {
  const root = project(t)
  const path = write(root, 'Empty.cs', 'using System;\n// nothing here\n')
  const result = classifyHotPaths(root, [path])
  assert.equal(result.files[0].state, 'hot')
  assert.equal(result.hot.length, 0)
})

test('an assembly definition or a deleted script needs a compile', (t) => {
  const root = project(t)
  const asmdef = write(root, 'x.asmdef', '{}')
  const missing = 'Assets/Scripts/Gone.cs'
  const result = classifyHotPaths(root, [asmdef, missing])
  assert.equal(result.needCompile.length, 2)
  assert.match(result.needCompile[0].reason, /assembly definition/)
  assert.match(result.needCompile[1].reason, /file was deleted/)
})

test('a script without its .meta is cold with an actionable reason', (t) => {
  const root = project(t)
  const path = write(root, 'NoMeta.cs', 'public class NoMeta { }\n', { meta: false })
  const result = classifyHotPaths(root, [path])
  assert.match(result.needCompile[0].reason, /no \.meta yet/)
})

test('a non-script and an outside path are failures, not cold files', (t) => {
  const root = project(t)
  write(root, 'Note.txt', 'text')
  const result = classifyHotPaths(root, ['Assets/Scripts/Note.txt', '../outside.cs'])
  assert.equal(result.failed.length, 2)
  assert.match(result.failed[0].error, /not a C# source file/)
  assert.match(result.failed[1].error, /not a project-relative Assets\/ or Packages\/ path/)
})

test('normalizeAssetPath understands absolute paths, backslashes and ./', (t) => {
  const root = project(t)
  assert.equal(normalizeAssetPath(root, 'Assets/Scripts/A.cs'), 'Assets/Scripts/A.cs')
  assert.equal(normalizeAssetPath(root, '.\\Assets\\Scripts\\A.cs'), 'Assets/Scripts/A.cs')
  assert.equal(normalizeAssetPath(root, `${root}\\Assets\\Scripts\\A.cs`), 'Assets/Scripts/A.cs')
  assert.equal(normalizeAssetPath(root, '/workspace/Other/Assets/A.cs'), null)
})

test('the lexer ignores declarations inside comments and strings', (t) => {
  const root = project(t)
  const path = write(root, 'S.cs', `public class S
{
    // class Fake { }
    public string Text = "class Fake { }";

    public void Tick()
    {
    }
}
`)
  const result = classifyHotPaths(root, [path])
  // The field `Text` is real, so this file is cold for the field, not for `Fake`.
  assert.match(result.needCompile[0].reason, /field layout/)
  assert.equal(stripCommentsAndStrings('// class X\nclass Y {}').includes('class X'), false)
})

test('reflectionName maps source types to reflection names', () => {
  assert.equal(reflectionName('int'), 'Int32')
  assert.equal(reflectionName('List<int>'), 'List`1')
  assert.equal(reflectionName('Dictionary<string, List<int>>'), 'Dictionary`2')
  assert.equal(reflectionName('int[]'), 'Int32[]')
  assert.equal(reflectionName('string?'), 'Nullable`1')
})