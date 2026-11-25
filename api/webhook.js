'use strict';

/**
 * Kalera Welcome Bot — GitHub App webhook handler (Vercel serverless function).
 *
 * Receives GitHub webhooks for `issues.opened` and `pull_request.opened`.
 * If the author is a first-time contributor to that repository, posts a warm
 * welcome comment and adds a `first-time` label (created if missing).
 * Bot accounts and the repository owner are skipped.
 *
 * Security / auth:
 *  - Every webhook is verified with HMAC SHA-256 (X-Hub-Signature-256)
 *    against WEBHOOK_SECRET, compared with crypto.timingSafeEqual.
 *  - The bot authenticates as a GitHub App: a short-lived JWT is signed
 *    from APP_ID + PRIVATE_KEY, exchanged for an installation access token,
 *    and all GitHub REST calls use that token.
 *
 * Response policy: a correctly signed webhook always gets a 200, even if
 * processing the event fails (logged server-side), so GitHub does not retry
 * a doomed delivery. A bad/missing signature gets 401.
 *
 * Env vars: APP_ID, PRIVATE_KEY (PEM, literal \n are converted),
 * WEBHOOK_SECRET. GITHUB_API_BASE is optional (defaults to
 * https://api.github.com) and exists so tests can point at a mock API.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const API_BASE = process.env.GITHUB_API_BASE || 'https://api.github.com';
const API_VERSION = '2022-11-28';
const LABEL_NAME = 'first-time';
const LABEL_COLOR = '0e8a16'; // green
const LABEL_DESCRIPTION = 'First-time contributor';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Read the raw request body (bodyParser must be off — see config below). */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Constant-time HMAC SHA-256 signature check. */
function verifySignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/** PRIVATE_KEY may be stored in env with literal \n — turn them into newlines. */
function getPrivateKey() {
  return (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n');
}

/** Short-lived GitHub App JWT (RS256, 9 min expiry, issued 60s in the past). */
function createAppJwt() {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 540, iss: process.env.APP_ID };
  return jwt.sign(payload, getPrivateKey(), { algorithm: 'RS256' });
}

/** Minimal GitHub REST call with a Bearer token. */
async function githubRequest(path, token, { method = 'GET', body } = {}) {
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Exchange the App JWT for an installation access token. */
async function getInstallationToken(installationId) {
  const appJwt = createAppJwt();
  const res = await githubRequest(`/app/installations/${installationId}/access_tokens`, appJwt, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`Installation token exchange failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.token;
}

/**
 * First-time check via the list-issues API (real-time, unlike the search
 * API whose index can lag). PRs are issues in the API, so this covers both.
 * The list includes the issue/PR that triggered this webhook (it is the
 * newest), so <= 1 item means this is the author's first contribution.
 */
async function isFirstTimeContributor(token, owner, repo, authorLogin) {
  const res = await githubRequest(
    `/repos/${owner}/${repo}/issues?creator=${encodeURIComponent(authorLogin)}&state=all&per_page=2`,
    token,
  );
  if (!res.ok) {
    throw new Error(`First-time check failed: HTTP ${res.status}`);
  }
  const items = await res.json();
  return Array.isArray(items) && items.length <= 1;
}

/** Create the `first-time` label if it does not exist yet. */
async function ensureLabel(token, owner, repo) {
  const getRes = await githubRequest(
    `/repos/${owner}/${repo}/labels/${encodeURIComponent(LABEL_NAME)}`,
    token,
  );
  if (getRes.ok) return;
  if (getRes.status !== 404) {
    throw new Error(`Label lookup failed: HTTP ${getRes.status}`);
  }
  const createRes = await githubRequest(`/repos/${owner}/${repo}/labels`, token, {
    method: 'POST',
    body: { name: LABEL_NAME, color: LABEL_COLOR, description: LABEL_DESCRIPTION },
  });
  if (!createRes.ok) {
    throw new Error(`Label creation failed: HTTP ${createRes.status}`);
  }
}

async function addLabelToIssue(token, owner, repo, issueNumber) {
  const res = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, token, {
    method: 'POST',
    body: { labels: [LABEL_NAME] },
  });
  if (!res.ok) {
    throw new Error(`Adding label failed: HTTP ${res.status}`);
  }
}

function welcomeCommentBody(authorLogin, fullName, isPR) {
  const kind = isPR ? 'pull request' : 'issue';
  return (
    `Hi @${authorLogin}, welcome to **${fullName}** — thank you for opening your first ${kind} here! 🎉\n\n` +
    `A maintainer will take a look soon.`
  );
}

async function postWelcomeComment(token, owner, repo, issueNumber, authorLogin, fullName, isPR) {
  const res = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token, {
    method: 'POST',
    body: { body: welcomeCommentBody(authorLogin, fullName, isPR) },
  });
  if (!res.ok) {
    throw new Error(`Posting comment failed: HTTP ${res.status}`);
  }
}

function isBot(login) {
  return typeof login === 'string' && login.endsWith('[bot]');
}

/* ------------------------------------------------------------------ */
/* Event handling                                                      */
/* ------------------------------------------------------------------ */

async function handleEvent(event, payload) {
  const repo = payload.repository;
  if (!repo) return { action: 'ignored', reason: 'no repository in payload' };

  const owner = repo.owner && repo.owner.login;
  const repoName = repo.name;
  const fullName = repo.full_name;

  let issueOrPr = null;
  let isPR = false;
  if (event === 'issues' && payload.action === 'opened') {
    issueOrPr = payload.issue;
  } else if (event === 'pull_request' && payload.action === 'opened') {
    issueOrPr = payload.pull_request;
    isPR = true;
  } else {
    return { action: 'ignored', reason: `unsupported event/action: ${event}/${payload.action}` };
  }
  if (!issueOrPr || !issueOrPr.user) {
    return { action: 'ignored', reason: 'missing issue/PR or author' };
  }

  const author = issueOrPr.user.login;
  if (isBot(author)) return { action: 'skipped', reason: 'bot account' };
  if (author === owner) return { action: 'skipped', reason: 'repository owner' };

  const installationId = payload.installation && payload.installation.id;
  if (!installationId) return { action: 'error', reason: 'missing installation id' };

  const token = await getInstallationToken(installationId);
  const firstTime = await isFirstTimeContributor(token, owner, repoName, author);
  if (!firstTime) return { action: 'skipped', reason: 'not a first-time contributor' };

  await ensureLabel(token, owner, repoName);
  await addLabelToIssue(token, owner, repoName, issueOrPr.number);
  await postWelcomeComment(token, owner, repoName, issueOrPr.number, author, fullName, isPR);
  return { action: 'welcomed', reason: 'first-time contributor' };
}

/* ------------------------------------------------------------------ */
/* Vercel handler                                                      */
/* ------------------------------------------------------------------ */

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error('WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Could not read body' });
  }

  if (!verifySignature(secret, rawBody, req.headers['x-hub-signature-256'])) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const event = req.headers['x-github-event'];
  if (event === 'ping') {
    return res.status(200).json({ ok: true, message: 'pong' });
  }

  // Correctly signed webhook: always answer 200, even if processing fails
  // (failures are logged; a 500 would make GitHub retry a doomed delivery).
  try {
    const result = await handleEvent(event, payload);
    console.log('webhook processed:', JSON.stringify(result));
  } catch (err) {
    console.error('webhook processing failed:', err);
  }
  return res.status(200).json({ ok: true });
}

// Vercel needs the raw body for signature verification — disable its parser.
module.exports = handler;
module.exports.config = { api: { bodyParser: false } };

// Exported for the local test script.
module.exports.verifySignature = verifySignature;
module.exports.createAppJwt = createAppJwt;
module.exports.handleEvent = handleEvent;
module.exports.welcomeCommentBody = welcomeCommentBody;
