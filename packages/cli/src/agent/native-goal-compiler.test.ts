import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classifyNativeGoal, compileNativeGoal, parseNativeExactReplacement } from './native-goal-compiler'

const emptySearcher = { searchBounded: () => ({ results: [], sourceWarnings: [], partial: false }) } as never

test('classifies read-only and mutation intent without granting authority', () => {
  assert.equal(classifyNativeGoal('Inspect why the tests fail and explain the cause.'), 'read_only')
  assert.equal(classifyNativeGoal('Fix the source registration bug and run the tests.'), 'implementation')
  assert.equal(classifyNativeGoal('Fix this, validate it, and commit it.'), 'commit')
  assert.equal(classifyNativeGoal('Push the release.'), 'push')
  assert.equal(classifyNativeGoal('Do not edit anything; inspect only.'), 'read_only')
})

test('compiles a bounded read-only goal into canonical goalDispatch', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-goal-'))
  fs.writeFileSync(path.join(sourceRoot, 'README.md'), '# Fixture\n', 'utf8')
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"private":true}\n', 'utf8')
  try {
    const result = await compileNativeGoal({
      goal: 'Inspect why the tests fail and explain the cause.',
      sourceId: 'source-native-test',
      sourceRoot,
      searcher: emptySearcher
    })
    assert.equal(result.route, 'goal_dispatch')
    assert.equal(result.intent, 'read_only')
    assert.equal(result.dispatch?.readOnly, true)
    assert.deepEqual(result.dispatch?.steps, [])
    assert.equal(result.dispatch?.confirmationPolicy, 'none')
    assert.ok((result.dispatch?.reads?.length || 0) > 0)
    assert.ok((result.dispatch?.commands?.length || 0) > 0)
    assert.ok((result.dispatch?.scope.length || 0) > 0)
    assert.ok(result.dispatch?.scope.every(item => !item.startsWith('/')))
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('routes mutation and delivery intent to existing governed paths', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-goal-'))
  try {
    const mutation = await compileNativeGoal({ goal: 'Fix the failing test.', sourceId: 'source-native-test', sourceRoot, searcher: emptySearcher })
    const delivery = await compileNativeGoal({ goal: 'Push this release.', sourceId: 'source-native-test', sourceRoot, searcher: emptySearcher })
    assert.equal(mutation.route, 'roadmap')
    assert.equal(delivery.route, 'blocked')
    assert.match(delivery.reviewMessage, /delivery authority/i)
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('admits only a confirmed one-match exact replacement for bounded Direct edits', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-direct-'))
  fs.writeFileSync(path.join(sourceRoot, 'fixture.txt'), 'before\nafter\n', 'utf8')
  const goal = 'replace exact text <<<before>>> with <<<updated>>> in fixture.txt'
  try {
    assert.deepEqual(parseNativeExactReplacement(goal), { path: 'fixture.txt', find: 'before', replace: 'updated' })
    const unconfirmed = await compileNativeGoal({ goal, sourceId: 'source-native-test', sourceRoot, searcher: emptySearcher })
    assert.equal(unconfirmed.route, 'blocked')
    assert.match(unconfirmed.reviewMessage, /confirmedByUser/i)

    const confirmed = await compileNativeGoal({ goal, sourceId: 'source-native-test', sourceRoot, searcher: emptySearcher, confirmedByUser: true })
    assert.equal(confirmed.route, 'goal_dispatch')
    assert.equal(confirmed.dispatch?.confirmationPolicy, 'single_exact')
    assert.equal(confirmed.dispatch?.steps[0]?.type, 'patch')
    assert.equal(confirmed.dispatch?.steps[0]?.path, 'fixture.txt')
    assert.equal(confirmed.dispatch?.validation?.[0]?.commandKind, 'git_diff_check')

    const committed = await compileNativeGoal({ goal, sourceId: 'source-native-test', sourceRoot, searcher: emptySearcher, confirmedByUser: true, autoCommit: true })
    assert.equal(committed.route, 'goal_dispatch')
    assert.equal(committed.dispatch?.commit?.enabled, true)
    assert.equal(committed.dispatch?.commit?.authorized, true)
    assert.match(committed.dispatch?.commit?.message || '', /fixture\.txt/)
    assert.equal(committed.dispatch?.nonGoals?.includes('commit'), false)
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('uses explicit attached files as high-confidence context without repository discovery', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-attachments-'))
  const sourceFile = path.join(sourceRoot, 'src', 'command-runner.ts')
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true })
  fs.writeFileSync(sourceFile, 'export const commandRunner = true\n', 'utf8')
  let searches = 0
  const searcher = {
    searchBounded: () => {
      searches += 1
      return { results: [], sourceWarnings: [], partial: false }
    }
  } as never
  try {
    const result = await compileNativeGoal({
      goal: 'Explain why this fails.',
      sourceId: 'source-native-test',
      sourceRoot,
      searcher,
      paths: ['src/command-runner.ts']
    })
    assert.equal(result.route, 'goal_dispatch')
    assert.deepEqual(result.dispatch?.scope, ['src/command-runner.ts'])
    assert.deepEqual(result.dispatch?.knownFiles, ['src/command-runner.ts'])
    assert.equal(result.dispatch?.reads?.[0]?.path, 'src/command-runner.ts')
    assert.equal(searches, 0)
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('keeps an attached folder as bounded scope without ingesting its contents', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-folder-'))
  fs.mkdirSync(path.join(sourceRoot, 'packages', 'cli'), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'packages', 'cli', 'index.ts'), 'export {}\n', 'utf8')
  try {
    const result = await compileNativeGoal({
      goal: 'Explain the relevant code.',
      sourceId: 'source-native-test',
      sourceRoot,
      searcher: emptySearcher,
      paths: ['packages/cli']
    })
    assert.equal(result.route, 'goal_dispatch')
    assert.deepEqual(result.dispatch?.scope, ['packages/cli'])
    assert.equal(result.dispatch?.reads?.length, 0)
    assert.equal(result.dispatch?.commands?.[0]?.commandKind, 'run_exact_command')
    assert.deepEqual(result.dispatch?.commands?.[0]?.args?.slice(-1), ['packages/cli'])
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('keeps multiple explicit files exact, bounded, and discovery-free', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-multiple-'))
  fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'src', 'one.ts'), 'export const one = 1\n', 'utf8')
  fs.writeFileSync(path.join(sourceRoot, 'src', 'two.md'), '# two\n', 'utf8')
  let searches = 0
  try {
    const result = await compileNativeGoal({
      goal: 'Explain these files.',
      sourceId: 'source-native-test',
      sourceRoot,
      searcher: { searchBounded: () => { searches += 1; return { results: [], sourceWarnings: [], partial: false } } } as never,
      paths: ['src/one.ts', 'src/two.md']
    })
    assert.equal(result.route, 'goal_dispatch')
    assert.deepEqual(result.dispatch?.scope, ['src/one.ts', 'src/two.md'])
    assert.deepEqual(result.dispatch?.knownFiles, ['src/one.ts', 'src/two.md'])
    assert.deepEqual(result.dispatch?.reads?.map(item => item.path), ['src/one.ts', 'src/two.md'])
    assert.equal(searches, 0)
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('classifies large and unsupported attachments without reading their contents', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-bounded-'))
  fs.writeFileSync(path.join(sourceRoot, 'large.md'), 'x'.repeat(100 * 1024 + 1), 'utf8')
  fs.writeFileSync(path.join(sourceRoot, 'image.bin'), Buffer.from([0, 1, 2, 3]))
  try {
    const result = await compileNativeGoal({
      goal: 'Inspect the attached artifacts.',
      sourceId: 'source-native-test',
      sourceRoot,
      searcher: emptySearcher,
      paths: ['large.md', 'image.bin']
    })
    assert.equal(result.route, 'goal_dispatch')
    assert.deepEqual(result.dispatch?.scope, ['large.md', 'image.bin'])
    assert.deepEqual(result.dispatch?.reads, [])
    assert.ok(!JSON.stringify(result.context || {}).includes('x'.repeat(100)))
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('rejects an oversized explicit attachment set before planning', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-many-'))
  try {
    for (let index = 0; index < 21; index += 1) fs.writeFileSync(path.join(sourceRoot, `file-${index}.md`), '# file\n', 'utf8')
    const result = await compileNativeGoal({
      goal: 'Inspect these files.',
      sourceId: 'source-native-test',
      sourceRoot,
      searcher: emptySearcher,
      paths: Array.from({ length: 21 }, (_, index) => `file-${index}.md`)
    })
    assert.equal(result.route, 'blocked')
    assert.match(result.reviewMessage, /at most 20 attached paths/i)
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('revalidates a file that disappears before Run', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-stale-'))
  fs.writeFileSync(path.join(sourceRoot, 'will-disappear.md'), '# stale\n', 'utf8')
  fs.rmSync(path.join(sourceRoot, 'will-disappear.md'))
  try {
    const result = await compileNativeGoal({
      goal: 'Explain the attached file.',
      sourceId: 'source-native-test',
      sourceRoot,
      searcher: emptySearcher,
      paths: ['will-disappear.md']
    })
    assert.equal(result.route, 'blocked')
    assert.match(result.reviewMessage, /no longer available/i)
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('blocks attached paths outside the source and symlink escapes', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-containment-'))
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-outside-'))
  fs.writeFileSync(path.join(outsideRoot, 'secret.ts'), 'const secret = true\n', 'utf8')
  fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true })
  const escapePath = path.join(sourceRoot, 'src', 'escape.ts')
  try {
    fs.symlinkSync(path.join(outsideRoot, 'secret.ts'), escapePath)
    const traversal = await compileNativeGoal({ goal: 'Explain this.', sourceId: 'source-native-test', sourceRoot, searcher: emptySearcher, paths: ['../secret.ts'] })
    assert.equal(traversal.route, 'blocked')
    assert.match(traversal.reviewMessage, /repository-relative/i)
    const escape = await compileNativeGoal({ goal: 'Explain this.', sourceId: 'source-native-test', sourceRoot, searcher: emptySearcher, paths: ['src/escape.ts'] })
    assert.equal(escape.route, 'blocked')
    assert.match(escape.reviewMessage, /outside/i)
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
    fs.rmSync(outsideRoot, { recursive: true, force: true })
  }
})
