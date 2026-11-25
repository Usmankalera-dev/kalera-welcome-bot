'use strict';

/**
 * Local test for the Kalera Welcome Bot webhook handler.
 *
 * Spins up a mock GitHub API and the real handler on local HTTP servers,
 * then sends fake signed webhook payloads and asserts the behaviour.
 * No real GitHub credentials and no network access to GitHub are needed.
 *
 * Run:  npm test
 * Exit code is 0 when every check passes, 1 otherwise.
 */

const http = require('http');
const crypto = require('crypto');
const { generateKeyPairSync } = require('crypto');

/* ------------------------------------------------------------------ */
/* Test env — set BEFORE requiring the handler (it reads env at load). */
/* ------------------------------------------------------------------ */

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const MOCK_PORT = 49161;
const HANDLER_PORT = 49162;

process.env.APP_ID = '123456';
process.env.PRIVATE_KEY = privateKeyPem; // real PEM generated for this run only
process.env.WEBHOOK_SECRET = 'test-webhook-secret';
process.env.GITHUB_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;

const handler = require('../api/webhook');

/* ------------------------------------------------------------------ */
/* Mock GitHub API                                                     */
/* ------------------------------------------------------------------ */

// `calls` records every request the handler makes to the mock API.
// `scenario` is changed between tests to control the mock's answers.
const calls = [];
const scenario = { issueCount: 1, labelExists: false };

function mockHandler(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    calls.push({
      method: req.method,
      path: url.pathname + url.search,
      headers: req.headers,
      body,
    });
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // POST /app/installations/:id/access_tokens
    if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return send(201, { token: 'ghs_testtoken', expires_at: '2027-01-01T00:00:00Z' });
    }
    // GET /repos/:owner/:repo/issues?creator=... (first-time check)
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname)) {
      const items = Array.from({ length: scenario.issueCount }, (_, i) => ({
        id: i + 1,
        number: 42 - i,
      }));
      return send(200, items);
    }
    // GET /repos/:owner/:repo/labels/first-time
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/labels\/first-time$/.test(url.pathname)) {
      return scenario.labelExists
        ? send(200, { name: 'first-time' })
        : send(404, { message: 'Not Found' });
    }
    // POST /repos/:owner/:repo/labels
    if (req.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(url.pathname)) {
      return send(201, { name: 'first-time', color: '0e8a16' });
    }
    // POST /repos/:owner/:repo/issues/:number/labels
    if (
      req.method === 'POST' &&
      /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/.test(url.pathname)
    ) {
      return send(200, [{ name: 'first-time' }]);
    }
    // POST /repos/:owner/:repo/issues/:number/comments
    if (
      req.method === 'POST' &&
      /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(url.pathname)
    ) {
      return send(201, { id: 1 });
    }
    return send(404, { message: 'mock: route not implemented' });
  });
}

/* ------------------------------------------------------------------ */
/* Handler server (plain Node http + a tiny Vercel-style res shim)     */
/* ------------------------------------------------------------------ */

function handlerServer(req, res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  return handler(req, res);
}

/* ------------------------------------------------------------------ */
/* Test helpers                                                        */
/* ------------------------------------------------------------------ */

function sign(raw) {
  return (
    'sha256=' +
    crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(raw).digest('hex')
  );
}

async function postWebhook(payload, { signature, event = 'issues' } = {}) {
  const raw = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
  };
  if (signature === undefined) headers['X-Hub-Signature-256'] = sign(raw);
  else if (signature) headers['X-Hub-Signature-256'] = signature;
  const res = await fetch(`http://127.0.0.1:${HANDLER_PORT}/api/webhook`, {
    method: 'POST',
    headers,
    body: raw,
  });
  return { status: res.status, body: await res.text() };
}

function issuePayload(authorLogin, { action = 'opened', number = 42 } = {}) {
  return {
    action,
    installation: { id: 999 },
    repository: {
      id: 1,
      name: 'demo-repo',
      full_name: 'octocat/demo-repo',
      owner: { login: 'octocat' },
    },
    issue: { number, title: 'Hello', user: { login: authorLogin } },
  };
}

function prPayload(authorLogin) {
  const payload = issuePayload(authorLogin, { number: 7 });
  payload.pull_request = { number: 7, title: 'Fix thing', user: { login: authorLogin } };
  delete payload.issue;
  return payload;
}

function hasCall(method, pathPart) {
  return calls.some((c) => c.method === method && c.path.includes(pathPart));
}

function getCall(method, pathPart) {
  return calls.find((c) => c.method === method && c.path.includes(pathPart));
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function runTests() {
  console.log('Kalera Welcome Bot — local tests\n');

  // 1. Bad signature -> 401, no GitHub API calls
  calls.length = 0;
  let r = await postWebhook(issuePayload('newbie'), { signature: 'sha256=deadbeef' });
  check('bad signature returns 401', r.status === 401, `got ${r.status}`);
  check('bad signature makes no GitHub calls', calls.length === 0, `${calls.length} calls made`);

  // 2. Missing signature -> 401
  calls.length = 0;
  r = await postWebhook(issuePayload('newbie'), { signature: null });
  check('missing signature returns 401', r.status === 401, `got ${r.status}`);

  // 3. Ping event with valid signature -> 200, no GitHub API calls
  calls.length = 0;
  r = await postWebhook({ zen: 'Keep it simple.' }, { event: 'ping' });
  check('ping returns 200', r.status === 200, `got ${r.status}`);
  check('ping makes no GitHub calls', calls.length === 0, `${calls.length} calls made`);

  // 4. Bot author -> 200, skipped before any GitHub call
  calls.length = 0;
  r = await postWebhook(issuePayload('some-bot[bot]'));
  check('bot author returns 200', r.status === 200, `got ${r.status}`);
  check('bot author makes no GitHub calls', calls.length === 0, `${calls.length} calls made`);

  // 5. Repository owner -> 200, skipped before any GitHub call
  calls.length = 0;
  r = await postWebhook(issuePayload('octocat'));
  check('owner author returns 200', r.status === 200, `got ${r.status}`);
  check('owner author makes no GitHub calls', calls.length === 0, `${calls.length} calls made`);

  // 6. First-time issue author, label does not exist yet -> full welcome flow
  calls.length = 0;
  scenario.issueCount = 1; // only the triggering issue exists
  scenario.labelExists = false;
  r = await postWebhook(issuePayload('newbie'));
  check('first-time issue returns 200', r.status === 200, `got ${r.status}`);
  check(
    'token exchange called with a Bearer JWT',
    hasCall('POST', '/app/installations/999/access_tokens') &&
      /^Bearer eyJ/.test(getCall('POST', '/app/installations/999/access_tokens').headers.authorization || ''),
    'no JWT bearer on token exchange',
  );
  check('first-time check called', hasCall('GET', '/repos/octocat/demo-repo/issues?'));
  check('label lookup called', hasCall('GET', '/repos/octocat/demo-repo/labels/first-time'));
  check('missing label is created', hasCall('POST', '/repos/octocat/demo-repo/labels'));
  check('label added to issue', hasCall('POST', '/repos/octocat/demo-repo/issues/42/labels'));
  const commentCall = getCall('POST', '/repos/octocat/demo-repo/issues/42/comments');
  check('welcome comment posted', Boolean(commentCall));
  if (commentCall) {
    const commentBody = JSON.parse(commentCall.body).body;
    check(
      'comment mentions repo and author',
      commentBody.includes('octocat/demo-repo') && commentBody.includes('@newbie'),
      commentBody,
    );
  }

  // 7. First-time author, label already exists -> no label creation, still welcomed
  calls.length = 0;
  scenario.issueCount = 1;
  scenario.labelExists = true;
  r = await postWebhook(issuePayload('newbie2'));
  check('label exists: returns 200', r.status === 200, `got ${r.status}`);
  check(
    'label exists: no label creation call',
    !hasCall('POST', '/repos/octocat/demo-repo/labels'),
  );
  check(
    'label exists: comment still posted',
    hasCall('POST', '/repos/octocat/demo-repo/issues/42/comments'),
  );

  // 8. Repeat PR author -> 200, checked, but no comment or label
  calls.length = 0;
  scenario.issueCount = 2; // triggering PR + one earlier contribution
  scenario.labelExists = false;
  r = await postWebhook(prPayload('regular'), { event: 'pull_request' });
  check('repeat PR author returns 200', r.status === 200, `got ${r.status}`);
  check('repeat author: first-time check called', hasCall('GET', '/repos/octocat/demo-repo/issues?'));
  check(
    'repeat author: no comment posted',
    !hasCall('POST', '/repos/octocat/demo-repo/issues/7/comments'),
  );
  check(
    'repeat author: no label added',
    !hasCall('POST', '/repos/octocat/demo-repo/issues/7/labels'),
  );

  // 9. Unsupported event -> 200, ignored
  calls.length = 0;
  r = await postWebhook({ action: 'created', repository: issuePayload('x').repository }, { event: 'push' });
  check('unsupported event returns 200', r.status === 200, `got ${r.status}`);
  check('unsupported event makes no GitHub calls', calls.length === 0, `${calls.length} calls made`);

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

/* ------------------------------------------------------------------ */
/* Boot servers, run, shut down                                       */
/* ------------------------------------------------------------------ */

const mockServer = http.createServer(mockHandler);
const appServer = http.createServer(handlerServer);

mockServer.listen(MOCK_PORT, '127.0.0.1', () => {
  appServer.listen(HANDLER_PORT, '127.0.0.1', async () => {
    let ok = false;
    try {
      ok = await runTests();
    } catch (err) {
      console.error('Test run crashed:', err);
    } finally {
      appServer.close();
      mockServer.close();
      process.exit(ok ? 0 : 1);
    }
  });
});
