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
