import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({ entryPoints: ['review-refresh.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '.test-build/review-refresh.mjs' });
const reviewRefresh = await import(`${pathToFileURL(`${process.cwd()}/.test-build/review-refresh.mjs`).href}?${Date.now()}`);

test('a restored Review Center renders and starts loading comments when it opens', () => {
	const events = [];
	reviewRefresh.activateReviewCenter(
		() => events.push('rendered'),
		async () => { events.push('refresh-started'); },
	);
	assert.deepEqual(events, ['rendered', 'refresh-started']);
});

test('overlapping review refreshes share one request', async () => {
	let resolveRequest;
	let calls = 0;
	const gate = new reviewRefresh.ReviewRefreshGate();
	const action = () => {
		calls += 1;
		return new Promise((resolve) => { resolveRequest = resolve; });
	};

	const first = gate.run('changes/a', action);
	const second = gate.run('changes/a', action);
	assert.equal(first, second);
	assert.equal(calls, 1);
	resolveRequest('loaded');
	assert.equal(await first, 'loaded');
	assert.equal(await gate.run('changes/a', async () => {
		calls += 1;
		return 'reloaded';
	}), 'reloaded');
	assert.equal(calls, 2);
});

test('a branch change queues one refresh behind the active branch', async () => {
	let resolveFirst;
	const calls = [];
	const gate = new reviewRefresh.ReviewRefreshGate();
	const first = gate.run('changes/a', () => {
		calls.push('a');
		return new Promise((resolve) => { resolveFirst = resolve; });
	});
	const second = gate.run('changes/b', async () => {
		calls.push('b');
		return 'branch-b';
	});
	const duplicate = gate.run('changes/b', async () => {
		calls.push('duplicate-b');
		return 'duplicate';
	});

	assert.deepEqual(calls, ['a']);
	resolveFirst('branch-a');
	assert.equal(await first, 'branch-a');
	assert.equal(await second, 'branch-b');
	assert.equal(await duplicate, 'branch-b');
	assert.deepEqual(calls, ['a', 'b']);
});

test('a failed review refresh settles and can be retried', async () => {
	let calls = 0;
	const gate = new reviewRefresh.ReviewRefreshGate();
	await assert.rejects(gate.run('changes/a', async () => {
		calls += 1;
		throw new Error('GitHub unavailable');
	}), /GitHub unavailable/);

	assert.equal(await gate.run('changes/a', async () => {
		calls += 1;
		return 'recovered';
	}), 'recovered');
	assert.equal(calls, 2);
});
