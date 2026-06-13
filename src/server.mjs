import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFile } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── SSE clients ────────────────────────────────────────────────────────────────

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function formatRelativeTime(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ago`;
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours} h ${rem} min` : `${hours} h`;
}

// ── Git worktrees ──────────────────────────────────────────────────────────────

function getGitWorktrees(cwd) {
  try {
    const out = execSync('git worktree list --porcelain', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const worktrees = [];
    for (const block of out.trim().split(/\n\n+/)) {
      const wt = {};
      for (const line of block.trim().split('\n')) {
        if (line.startsWith('worktree ')) wt.path = line.slice(9);
        else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace('refs/heads/', '');
        else if (line === 'bare') wt.bare = true;
        else if (line === 'detached') wt.branch = 'HEAD (detached)';
      }
      if (wt.path && !wt.bare) worktrees.push(wt);
    }
    return worktrees;
  } catch {
    return [];
  }
}

// ── Claude session JSONL ───────────────────────────────────────────────────────

function findProjectDir(worktreePath) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  const encoded = worktreePath.replace(/^\//, '').replace(/\//g, '-');
  const direct = path.join(projectsDir, encoded);
  if (fs.existsSync(direct)) return direct;

  // Fallback: scan for the closest match by basename
  let best = null;
  let bestScore = 0;
  const basename = path.basename(worktreePath);
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      if (dir.endsWith(basename) || dir.endsWith(`-${basename}`)) {
        const score = dir.length;
        if (score > bestScore) {
          bestScore = score;
          best = path.join(projectsDir, dir);
        }
      }
    }
  } catch {}
  return best;
}

function latestJsonl(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  let latestPath = null, latestMtime = 0;
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(dir, file);
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > latestMtime) { latestMtime = mtime; latestPath = full; }
    }
  } catch {}
  return latestPath ? { path: latestPath, mtime: latestMtime } : null;
}

function parseSession(projectDir) {
  const latest = latestJsonl(projectDir);
  if (!latest) return null;

  let lines;
  try {
    lines = fs.readFileSync(latest.path, 'utf8').split('\n').filter(l => l.trim());
  } catch {
    return null;
  }

  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  if (events.length === 0) return null;

  const result = {
    lastTool: null,
    lastFile: null,
    lastLine: null,
    lastMessage: null,
    changedFiles: new Set(),
    tokenCount: 0,
    firstTs: null,
    lastTs: null,
    lastEventType: null,
    lastHasToolCall: false,
  };

  for (const ev of events) {
    const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : null;
    if (ts && !isNaN(ts)) {
      if (!result.firstTs) result.firstTs = ts;
      result.lastTs = ts;
    }

    const type = ev.type;

    if (type === 'assistant') {
      result.lastEventType = 'assistant';
      result.lastHasToolCall = false;
      const content = ev.message?.content ?? [];
      for (const item of Array.isArray(content) ? content : []) {
        if (item.type === 'text' && item.text) {
          result.lastMessage = item.text.trim();
        }
        if (item.type === 'tool_use') {
          result.lastHasToolCall = true;
          result.lastTool = item.name;
          const inp = item.input ?? {};
          const filePath = inp.file_path ?? inp.path ?? null;
          if (filePath) {
            result.lastFile = filePath;
            if (['Write', 'Edit', 'NotebookEdit'].includes(item.name)) {
              result.changedFiles.add(filePath);
            }
          }
          if (inp.line != null) result.lastLine = inp.line;
          else if (inp.old_string != null && result.lastFile) {
            // Edit tool — no line number in spec but keep file
          }
        }
      }
      if (ev.message?.usage?.output_tokens) {
        result.tokenCount = ev.message.usage.output_tokens;
      }
    } else if (type === 'user') {
      result.lastEventType = 'user';
    }
  }

  // Infer status
  const now = Date.now();
  const idleMs = result.lastTs ? now - result.lastTs : Infinity;

  let status;
  if (!result.lastTs) {
    status = 'no session';
  } else if (idleMs > 5 * 60 * 1000) {
    status = 'idle';
  } else if (idleMs < 30 * 1000) {
    status = result.lastHasToolCall ? 'working' : 'thinking';
  } else {
    const msg = result.lastMessage ?? '';
    const hasQuestion = msg.includes('?') || msg.endsWith(':');
    status = hasQuestion ? 'waiting' : 'done';
  }

  return {
    status,
    lastTool: result.lastTool,
    lastFile: result.lastFile,
    lastLine: result.lastLine,
    lastMessage: result.lastMessage,
    lastActivity: result.lastTs ? formatRelativeTime(result.lastTs) : null,
    changedFiles: [...result.changedFiles].slice(-10),
    tokenCount: result.tokenCount,
    sessionDuration: (result.firstTs && result.lastTs) ? formatDuration(result.lastTs - result.firstTs) : null,
  };
}

// ── Worktree data assembly ─────────────────────────────────────────────────────

function buildWorktreeData(config) {
  const worktrees = getGitWorktrees(config.cwd);
  return worktrees.map((wt, i) => {
    const name = path.basename(wt.path);
    const isMain = i === 0;
    const projectDir = findProjectDir(wt.path);
    const session = parseSession(projectDir);
    return {
      name,
      path: wt.path,
      branch: wt.branch ?? '',
      isMain,
      status: session?.status ?? 'no session',
      lastTool: session?.lastTool ?? null,
      lastFile: session?.lastFile ?? null,
      lastLine: session?.lastLine ?? null,
      lastMessage: session?.lastMessage ?? null,
      lastActivity: session?.lastActivity ?? null,
      changedFiles: session?.changedFiles ?? [],
      tokenCount: session?.tokenCount ?? 0,
      sessionDuration: session?.sessionDuration ?? null,
    };
  });
}

// ── Route handlers ─────────────────────────────────────────────────────────────

function serveHTML(res, config) {
  const htmlPath = path.join(__dirname, 'dashboard.html');
  let html;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch {
    res.writeHead(500);
    res.end('dashboard.html not found');
    return;
  }
  const configScript = `<script>window.__CONFIG__ = ${JSON.stringify(config)};</script>`;
  html = html.replace('</head>', configScript + '\n</head>');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':\n\n'); // comment to flush
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function handleGetWorktrees(req, res, config) {
  json(res, buildWorktreeData(config));
}

function handleCreateWorktree(req, res, config) {
  readBody(req).then(({ name, branch }) => {
    if (!name || !branch) return json(res, { error: 'name and branch required' }, 400);
    const script = path.join(__dirname, 'worktree-add.sh');
    const worktreesPath = path.resolve(config.cwd, config.worktrees);
    execFile('bash', [script, name, branch, worktreesPath], { cwd: config.cwd }, (err, stdout, stderr) => {
      if (err) return json(res, { error: stderr.trim() || err.message }, 500);
      json(res, { ok: true, path: path.join(worktreesPath, name) });
    });
  });
}

function handleRemoveWorktree(req, res, config) {
  readBody(req).then(({ name }) => {
    if (!name) return json(res, { error: 'name required' }, 400);
    const target = buildWorktreeData(config).find((wt) => wt.name === name);
    if (target?.isMain) return json(res, { error: 'cannot remove the main worktree' }, 400);
    const script = path.join(__dirname, 'worktree-remove.sh');
    const worktreesPath = path.resolve(config.cwd, config.worktrees);
    execFile('bash', [script, name, worktreesPath], { cwd: config.cwd }, (err, stdout, stderr) => {
      if (err) return json(res, { error: stderr.trim() || err.message }, 500);
      json(res, { ok: true });
    });
  });
}

function handleOpen(req, res) {
  readBody(req).then(({ path: p }) => {
    if (!p) return json(res, { error: 'path required' }, 400);
    execFile('code', [p], (err) => {
      if (err) return json(res, { error: err.message }, 500);
      json(res, { ok: true });
    });
  });
}

function handleOpenFile(req, res) {
  readBody(req).then(({ path: p, line }) => {
    if (!p) return json(res, { error: 'path required' }, 400);
    const target = line ? `${p}:${line}` : p;
    execFile('code', ['--goto', target], (err) => {
      if (err) return json(res, { error: err.message }, 500);
      json(res, { ok: true });
    });
  });
}

// ── Server factory ─────────────────────────────────────────────────────────────

export function createServer(config) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:' + config.port);

    const { method } = req;
    const pathname = new URL(req.url, `http://localhost`).pathname;

    if (method === 'GET' && pathname === '/') return serveHTML(res, config);
    if (method === 'GET' && pathname === '/events') return handleSSE(req, res);
    if (method === 'GET' && pathname === '/api/worktrees') return handleGetWorktrees(req, res, config);
    if (method === 'POST' && pathname === '/api/worktree/create') return handleCreateWorktree(req, res, config);
    if (method === 'POST' && pathname === '/api/worktree/remove') return handleRemoveWorktree(req, res, config);
    if (method === 'POST' && pathname === '/api/open') return handleOpen(req, res);
    if (method === 'POST' && pathname === '/api/open-file') return handleOpenFile(req, res);
    if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    res.writeHead(404);
    res.end('Not found');
  });

  // SSE broadcast loop — every 3 s
  const interval = setInterval(() => {
    const data = buildWorktreeData(config);
    broadcast('worktrees', data);
  }, 3000);

  server.on('close', () => clearInterval(interval));
  return server;
}
