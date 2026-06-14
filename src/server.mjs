import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── SSE clients ────────────────────────────────────────────────────────────────

const clients = new Set();

// ── Running dev-server processes ─────────────────────────────────────────────────
// Keyed by worktree name → { child, pid, port, script, status, logs, exitCode }
const processes = new Map();

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

// Recent commits for a worktree's checked-out branch. Newest first.
function getRecentCommits(worktreePath, limit = 5) {
  try {
    const out = execSync(
      `git log -n ${limit} --no-color --format=%h%x00%s%x00%cr%x00%an`,
      { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, relativeDate, author] = line.split('\0');
        return { hash, subject, relativeDate, author };
      });
  } catch {
    return [];
  }
}

// ── Dev-server processes ─────────────────────────────────────────────────────────

function readScripts(worktreePath, allowlist) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8'));
    const available = Object.keys(pkg.scripts || {});
    return allowlist.filter((s) => available.includes(s));
  } catch {
    return [];
  }
}

// Default port = basePort + worktree index, bumped past any port already in use.
function assignPort(config, index) {
  const base = config.run?.basePort ?? 4200;
  const used = new Set([...processes.values()].filter((p) => p.status === 'running').map((p) => p.port));
  let port = base + index;
  while (used.has(port)) port++;
  return port;
}

function runState(name) {
  const p = processes.get(name);
  if (!p) return null;
  return { script: p.script, port: p.port, status: p.status, exitCode: p.exitCode ?? null, url: `http://localhost:${p.port}` };
}

function startProcess(config, wt, index, script) {
  const port = assignPort(config, index);
  const cmd = config.run.command.replaceAll('{script}', script).replaceAll('{port}', String(port));

  // detached so we can kill the whole process group (npm → ng serve) on stop.
  const child = spawn(cmd, {
    cwd: wt.path,
    shell: true,
    detached: true,
    env: { ...process.env, PORT: String(port) },
  });

  const entry = { child, pid: child.pid, port, script, status: 'running', logs: [], exitCode: null };
  processes.set(wt.name, entry);

  const append = (buf) => {
    for (const line of buf.toString().split('\n')) {
      if (!line.trim()) continue;
      entry.logs.push(line);
      if (entry.logs.length > 200) entry.logs.shift();
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('exit', (code) => { entry.status = 'exited'; entry.exitCode = code; });
  child.on('error', (err) => { entry.status = 'exited'; entry.logs.push(`[spawn error] ${err.message}`); });

  return entry;
}

function stopProcess(name) {
  const entry = processes.get(name);
  if (!entry || entry.status !== 'running') return false;
  try {
    // negative pid → kill the entire process group started with detached: true
    process.kill(-entry.child.pid, 'SIGTERM');
  } catch {
    try { entry.child.kill('SIGTERM'); } catch {}
  }
  entry.status = 'exited';
  return true;
}

function stopAllProcesses() {
  for (const name of processes.keys()) stopProcess(name);
}

// ── Claude session JSONL ───────────────────────────────────────────────────────

function findProjectDir(worktreePath) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  // Claude Code names a project's session folder by replacing EVERY
  // non-alphanumeric character in the absolute path with '-' (slashes, dots,
  // and spaces all become '-', including the leading slash).
  const encoded = worktreePath.replace(/[^a-zA-Z0-9]/g, '-');
  const direct = path.join(projectsDir, encoded);
  if (fs.existsSync(direct)) return direct;

  // Fallback: scan for the closest match by basename. Normalize the basename
  // the same way so worktree folder names with spaces/dots still match.
  let best = null;
  let bestScore = 0;
  const basename = path.basename(worktreePath).replace(/[^a-zA-Z0-9]/g, '-');
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

// ── Worktree prompt log ────────────────────────────────────────────────────────

// Latest entry from the central, per-branch prompt log written by the Stop hook
// (.claude/hooks/log-prompt.sh). Logs live in the MAIN checkout so all worktrees
// share one gitignored location; the dashboard reads them from there.
function readWorktreeLog(mainPath, branch) {
  if (!mainPath || !branch) return null;
  const safe = branch.replace(/\//g, '-');
  const file = path.join(mainPath, '.worktree-logs', `${safe}.jsonl`);
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    // A "start" entry with no following "done" means the turn is still in flight
    // → show it as the current task. Otherwise show the completed summary.
    if (last.kind === 'start') {
      return {
        working: true,
        text: last.prompt ?? null,
        files: [],
        at: last.ts ? formatRelativeTime(last.ts) : null,
      };
    }
    return {
      working: false,
      text: last.summary ?? null,
      files: Array.isArray(last.files) ? last.files : [],
      at: last.ts ? formatRelativeTime(last.ts) : null,
    };
  } catch {
    return null;
  }
}

// ── Worktree data assembly ─────────────────────────────────────────────────────

function buildWorktreeData(config) {
  const worktrees = getGitWorktrees(config.cwd);
  const mainPath = worktrees[0]?.path ?? config.cwd;
  return worktrees.map((wt, i) => {
    const name = path.basename(wt.path);
    const isMain = i === 0;
    const projectDir = findProjectDir(wt.path);
    const session = parseSession(projectDir);
    const scripts = config.run ? readScripts(wt.path, config.run.scripts) : [];
    const commits = getRecentCommits(wt.path);
    const lastPrompt = readWorktreeLog(mainPath, wt.branch);
    return {
      name,
      path: wt.path,
      branch: wt.branch ?? '',
      isMain,
      scripts,
      commits,
      lastPrompt,
      defaultPort: config.run ? (config.run.basePort ?? 4200) + i : null,
      running: runState(name),
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

const VAR_PATTERN = /^[A-Za-z0-9._/-]+$/;

// Replace {key} tokens in a string with sanitized variable values.
function interpolate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  );
}

// Write the predefined prompt + a folder-open task that auto-launches Claude.
function writeTemplateFiles(worktreePath, prompt) {
  fs.writeFileSync(path.join(worktreePath, 'CLAUDE_TASK.md'), prompt + '\n');
  const vscodeDir = path.join(worktreePath, '.vscode');
  fs.mkdirSync(vscodeDir, { recursive: true });
  const tasks = {
    version: '2.0.0',
    tasks: [
      {
        label: 'Start Claude',
        type: 'shell',
        command: 'claude',
        args: ['Read CLAUDE_TASK.md and follow the instructions in it.'],
        presentation: { reveal: 'always', panel: 'dedicated', focus: true },
        runOptions: { runOn: 'folderOpen' },
        problemMatcher: [],
      },
    ],
  };
  fs.writeFileSync(path.join(vscodeDir, 'tasks.json'), JSON.stringify(tasks, null, 2) + '\n');
}

function handleCreateWorktree(req, res, config) {
  readBody(req).then(({ name, branch, template, vars }) => {
    let prompt = null;

    if (template) {
      const def = (config.templates || []).find((t) => t.id === template);
      if (!def) return json(res, { error: `unknown template '${template}'` }, 400);
      vars = vars || {};
      for (const field of def.fields || []) {
        const value = (vars[field.key] ?? '').trim();
        if (!value) return json(res, { error: `${field.label || field.key} is required` }, 400);
        if (!VAR_PATTERN.test(value) || value.includes('..')) {
          return json(res, { error: `${field.label || field.key} contains invalid characters` }, 400);
        }
        vars[field.key] = value;
      }
      name = interpolate(def.name, vars);
      branch = interpolate(def.branch, vars);
      prompt = interpolate(def.prompt, vars);
    }

    if (!name || !branch) return json(res, { error: 'name and branch required' }, 400);
    const script = path.join(__dirname, 'worktree-add.sh');
    const worktreesPath = path.resolve(config.cwd, config.worktrees);
    execFile('bash', [script, name, branch, worktreesPath], { cwd: config.cwd }, (err, stdout, stderr) => {
      if (err) return json(res, { error: stderr.trim() || err.message }, 500);
      const worktreePath = path.join(worktreesPath, name);
      if (prompt) {
        try {
          writeTemplateFiles(worktreePath, prompt);
        } catch (e) {
          return json(res, { error: `worktree created but setup failed: ${e.message}` }, 500);
        }
      }
      json(res, { ok: true, path: worktreePath });
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

function handleStartScript(req, res, config) {
  readBody(req).then(({ name, script }) => {
    if (!config.run) return json(res, { error: 'script running is not configured' }, 400);
    if (!name || !script) return json(res, { error: 'name and script required' }, 400);
    const existing = processes.get(name);
    if (existing?.status === 'running') return json(res, { error: 'a script is already running' }, 400);

    const data = buildWorktreeData(config);
    const index = data.findIndex((wt) => wt.name === name);
    const wt = data[index];
    if (!wt) return json(res, { error: 'worktree not found' }, 404);
    if (!wt.scripts.includes(script)) return json(res, { error: `script "${script}" not allowed` }, 400);

    try {
      const entry = startProcess(config, wt, index, script);
      json(res, { ok: true, port: entry.port, url: `http://localhost:${entry.port}` });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });
}

function handleStopScript(req, res) {
  readBody(req).then(({ name }) => {
    if (!name) return json(res, { error: 'name required' }, 400);
    if (!stopProcess(name)) return json(res, { error: 'no running script' }, 400);
    json(res, { ok: true });
  });
}

function handleLogs(req, res) {
  const name = new URL(req.url, 'http://localhost').searchParams.get('name');
  const entry = name ? processes.get(name) : null;
  json(res, { logs: entry?.logs ?? [], status: entry?.status ?? null });
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
    if (method === 'POST' && pathname === '/api/worktree/start') return handleStartScript(req, res, config);
    if (method === 'POST' && pathname === '/api/worktree/stop') return handleStopScript(req, res);
    if (method === 'GET' && pathname === '/api/worktree/logs') return handleLogs(req, res);
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

  server.on('close', () => {
    clearInterval(interval);
    stopAllProcesses();
  });

  // Detached dev-server groups outlive the parent, so kill them synchronously on
  // exit too — the server 'close' event may not fire before process.exit().
  process.on('exit', stopAllProcesses);

  return server;
}
