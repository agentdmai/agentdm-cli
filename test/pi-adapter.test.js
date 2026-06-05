// Tests for PiAdapter argv construction.
//
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiAdapter } from '../src/lib/runtimes/pi.js';

function makeAdapter(options = {}) {
  return new PiAdapter({ agentDir: '/tmp/x', log: () => {}, env: {} }, options);
}

test('_buildArgs: print + trust flags, prompt last', () => {
  const args = makeAdapter()._buildArgs('check inbox');
  assert.deepEqual(args, ['-p', '-a', 'check inbox']);
});

test('_buildArgs: model is passed through', () => {
  const args = makeAdapter({ model: 'sonnet:high' })._buildArgs('go');
  assert.deepEqual(args, ['-p', '-a', '--model', 'sonnet:high', 'go']);
});

test('_buildArgs: extra args land before the positional prompt', () => {
  const args = makeAdapter({ extraArgs: ['--no-extensions'] })._buildArgs('go');
  assert.deepEqual(args, ['-p', '-a', '--no-extensions', 'go']);
  // Prompt must be the final token so it is never read as a flag value.
  assert.equal(args[args.length - 1], 'go');
});

test('Pi keeps no warm session between ticks', () => {
  const a = makeAdapter();
  assert.equal(a.supportsWarmSession(), false);
  assert.equal(a.supportsClearSession(), false);
});
