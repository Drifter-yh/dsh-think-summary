import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';

/** Build an app with a fake llm + webServer and return the route handler. */
function createApp({ config = {}, llm } = {}) {
  const routes = [];
  const calls = { llm: 0 };
  const fakeLlm = llm ?? {
    async *stream() {
      calls.llm += 1;
      yield { type: 'text-delta', text: '- First point\n- Second point\n- Third point\n' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'think-summary-'));
  const ctx = {
    llm: fakeLlm,
    get: (name) => (name === 'llm' ? fakeLlm : undefined),
    inject: (services, callback) => {
      callback({
        llm: fakeLlm,
        get: (name) => (name === 'llm' ? fakeLlm : undefined),
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          },
        },
      });
    },
  };
  apply(ctx, {
    cacheFile: join(dir, 'cache.json'),
    minChars: 10,
    ...config,
  });
  assert.equal(routes.length, 1, 'expected exactly one route registration');
  return {
    handler: routes[0].handler,
    calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Invoke the handler with a fake request and capture the response. */
async function request(handler, { method = 'POST', path = '/dsh-think-summary/summarize', body, address = '127.0.0.1' } = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method,
    url: path,
    socket: address === undefined ? undefined : { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload);
    },
  };
  let status = 0;
  let text = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(chunk) {
      text = chunk;
    },
  };
  await handler(req, res);
  return { status, json: text === '' ? null : JSON.parse(text) };
}

test('summarises a step and strips list markers', async () => {
  const app = createApp();
  try {
    const { status, json } = await request(app.handler, { body: { sessionId: 's1', text: 'x'.repeat(200) } });
    assert.equal(status, 200);
    assert.deepEqual(json.bullets, ['First point', 'Second point', 'Third point']);
    assert.equal(json.cached, false);
    assert.equal(app.calls.llm, 1);
  } finally {
    app.cleanup();
  }
});

test('identical reasoning is served from cache without a second call', async () => {
  const app = createApp();
  try {
    const body = { sessionId: 's1', text: 'y'.repeat(200) };
    const first = await request(app.handler, { body });
    const second = await request(app.handler, { body });
    assert.equal(first.json.cached, false);
    assert.equal(second.json.cached, true);
    assert.equal(app.calls.llm, 1);
  } finally {
    app.cleanup();
  }
});

test('short reasoning is skipped', async () => {
  const app = createApp({ config: { minChars: 50 } });
  try {
    const { json } = await request(app.handler, { body: { sessionId: 's1', text: 'short' } });
    assert.equal(json.skipped, 'too-short');
    assert.equal(app.calls.llm, 0);
  } finally {
    app.cleanup();
  }
});

test('the master switch disables model calls', async () => {
  const app = createApp({ config: { enabled: false } });
  try {
    const { json } = await request(app.handler, { body: { sessionId: 's1', text: 'z'.repeat(200) } });
    assert.equal(json.skipped, 'disabled');
    assert.equal(app.calls.llm, 0);
  } finally {
    app.cleanup();
  }
});

test('summarize requires POST', async () => {
  const app = createApp();
  try {
    const { status } = await request(app.handler, { method: 'GET' });
    assert.equal(status, 405);
  } finally {
    app.cleanup();
  }
});

test('non-loopback callers are rejected', async () => {
  const app = createApp();
  try {
    const { status } = await request(app.handler, { address: '10.1.2.3', body: { text: 'x' } });
    assert.equal(status, 403);
    assert.equal(app.calls.llm, 0);
  } finally {
    app.cleanup();
  }
});

test('oversized bodies are rejected', async () => {
  const app = createApp();
  try {
    const { status } = await request(app.handler, { body: 'x'.repeat(600 * 1024) });
    assert.equal(status, 413);
    assert.equal(app.calls.llm, 0);
  } finally {
    app.cleanup();
  }
});

test('a truncated model answer degrades to a 500 and does not cache', async () => {
  const app = createApp({
    llm: {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
      },
    },
  });
  try {
    const first = await request(app.handler, { body: { sessionId: 's1', text: 'w'.repeat(200) } });
    assert.equal(first.status, 500);
    assert.match(first.json.error, /超长|max/);
  } finally {
    app.cleanup();
  }
});
