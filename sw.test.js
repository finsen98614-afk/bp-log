// Service worker tests. acceptance.js cannot reach this code -- jsdom has no
// service worker -- so sw.js is loaded here under a stubbed SW global and its
// fetch handler is driven directly.
//
// Pass a path to check a different copy, which is how a change is compared
// against the version already deployed:
//   node sw.test.js                     # this repo's sw.js
//   node sw.test.js /tmp/old-sw.js      # some other build
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TARGET = process.argv[2] || path.join(__dirname, 'sw.js');
const SW = fs.readFileSync(TARGET, 'utf8');

// Load sw.js in a context that mimics the bits of the service worker global it
// touches. `netMode` shapes what the network does; `cacheHas` says whether this
// install already has a populated cache.
function load({ netMode, cacheHas }) {
  const listeners = {};
  const puts = [];
  const CACHED = { body: 'CACHED-SHELL', status: 200, type: 'basic', ok: true, clone: () => CACHED };
  const FRESH = { body: 'FRESH-SHELL', status: 200, type: 'basic', ok: true, clone: () => FRESH };
  const NOT_FOUND = { body: '404', status: 404, type: 'basic', ok: false, clone: () => NOT_FOUND };

  const ctx = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() }
    },
    caches: {
      open: async () => ({ put: req => puts.push(String(req.url || req)) }),
      match: async req => {
        if (!cacheHas) return undefined;
        const u = String(req && req.url ? req.url : req);
        return (u.endsWith('/') || u.includes('index.html') || u.includes('icon')) ? CACHED : undefined;
      },
      keys: async () => [],
      delete: async () => true
    },
    fetch: async () => {
      if (netMode === 'ok') return FRESH;
      if (netMode === 'notfound') return NOT_FOUND;
      if (netMode === 'slow') return new Promise(r => setTimeout(() => r(FRESH), 9000));
      throw new Error('offline');
    },
    Request: class { constructor(url, opts) { this.url = url; this.opts = opts; } },
    setTimeout, clearTimeout, Promise, console
  };
  vm.createContext(ctx);
  vm.runInContext(SW, ctx);
  return { listeners, puts };
}

// Resolves with what the worker chose to serve, or NO_RESPOND_WITH if it
// declined to handle the request at all.
function serve(listeners, request) {
  return new Promise(resolve => {
    listeners.fetch({ request, respondWith: p => resolve(Promise.resolve(p)) });
    setTimeout(() => resolve('NO_RESPOND_WITH'), 50);
  });
}

const NAV = { method: 'GET', mode: 'navigate', url: 'https://x.org/bp-log/' };
const ICON = { method: 'GET', mode: 'no-cors', url: 'https://x.org/bp-log/icon-192.png' };
const POST = { method: 'POST', mode: 'navigate', url: 'https://x.org/bp-log/' };

let passed = 0, failed = 0;
const failures = [];
function check(name, got, want) {
  if (got === want) { passed++; console.log('  PASS  ' + name); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}  -> got ${got}, want ${want}`); }
}

(async () => {
  console.log('\n=== SW-1  App shell is network-first ===');
  {
    // The regression this exists for: under cache-first the already-active
    // worker answered the navigation from its own cache, so a deploy stayed
    // invisible until the second launch. skipWaiting() cannot help -- by the
    // time the new worker claims the page, the old shell has been served.
    const { listeners, puts } = load({ netMode: 'ok', cacheHas: true });
    const res = await serve(listeners, NAV);
    check('SW-1.1 fresh shell wins over a warm cache', res.body, 'FRESH-SHELL');
    await new Promise(r => setTimeout(r, 20));
    check('SW-1.2 the fresh shell is written through to cache', puts.length, 1);
  }

  console.log('\n=== SW-2  Offline still works ===');
  {
    const { listeners } = load({ netMode: 'fail', cacheHas: true });
    check('SW-2.1 network failure falls back to the cached shell',
      (await serve(listeners, NAV)).body, 'CACHED-SHELL');
  }
  {
    const { listeners } = load({ netMode: 'notfound', cacheHas: true });
    check('SW-2.2 a non-OK status falls back rather than serving the error',
      (await serve(listeners, NAV)).body, 'CACHED-SHELL');
  }
  {
    // A dead-but-not-refusing connection must not stall startup forever.
    const { listeners } = load({ netMode: 'slow', cacheHas: true });
    const t0 = Date.now();
    const res = await serve(listeners, NAV);
    const ms = Date.now() - t0;
    check('SW-2.3 a hanging network falls back at NAV_TIMEOUT', res.body, 'CACHED-SHELL');
    check('SW-2.4 it does so in under 5s', ms < 5000, true);
    console.log(`        (fell back after ${ms}ms)`);
  }

  console.log('\n=== SW-3  Non-shell requests stay cache-first ===');
  {
    const { listeners } = load({ netMode: 'fail', cacheHas: true });
    check('SW-3.1 a warm asset is served instantly, even offline',
      (await serve(listeners, ICON)).body, 'CACHED-SHELL');
  }
  {
    const { listeners } = load({ netMode: 'ok', cacheHas: false });
    check('SW-3.2 a cold asset still reaches the network',
      (await serve(listeners, ICON)).body, 'FRESH-SHELL');
  }
  {
    const { listeners } = load({ netMode: 'ok', cacheHas: true });
    check('SW-3.3 non-GET is passed through untouched',
      await serve(listeners, POST), 'NO_RESPOND_WITH');
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed) failures.forEach(f => console.log('  - ' + f));
  process.exit(failed ? 1 : 0);
})();
