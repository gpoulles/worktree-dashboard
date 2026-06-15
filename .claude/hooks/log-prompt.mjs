#!/usr/bin/env node
// Stop hook — generates a one-line summary of the latest Claude turn and appends
// it to a per-branch log the dashboard reads.

import { execSync, spawn, spawnSync } from 'child_process';
import { mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

// Guard: the summary is produced by a headless `claude` call whose own Stop hook
// would re-trigger this script. Exit unless we're the intentional background worker.
if (process.env.WORKTREE_LOG_HOOK === '1' && process.argv[2] !== '--worker') process.exit(0);

if (process.argv[2] === '--worker') {
  runWorker();
} else {
  runHook().catch(() => {});
}

async function runHook() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }

  const transcriptPath = input.transcript_path ?? '';
  const cwd = input.cwd || process.cwd();
  if (!transcriptPath) return;

  try { process.chdir(cwd); } catch { return; }

  let common;
  try { common = execSync('git rev-parse --git-common-dir', { encoding: 'utf8' }).trim(); }
  catch { return; }

  const commonAbs = isAbsolute(common) ? common : join(cwd, common);
  const mainDir = dirname(commonAbs);

  let branch;
  try { branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); }
  catch { branch = 'detached'; }

  const safe = branch.replace(/\//g, '-');
  const logdir = join(mainDir, '.worktree-logs');

  // Spawn summarization in the background so we never add latency to the turn.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WORKTREE_LOG_HOOK: '1',
      _WTD_TRANSCRIPT: transcriptPath,
      _WTD_BRANCH: branch,
      _WTD_SAFE: safe,
      _WTD_LOGDIR: logdir,
    },
  });
  child.unref();
}

function getChangedFiles(transcriptPath) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
  } catch { return []; }

  const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // Find the last user event with actual text content (not a tool_result).
  let lastUserIdx = -1;
  for (let i = 0; i < all.length; i++) {
    const entry = all[i];
    if (entry.type !== 'user') continue;
    const content = entry.message?.content;
    if (typeof content === 'string') { lastUserIdx = i; continue; }
    if (Array.isArray(content) && content.some(c => c.type === 'text')) lastUserIdx = i;
  }

  const files = new Set();
  for (let i = lastUserIdx + 1; i < all.length; i++) {
    const entry = all[i];
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' &&
          ['Write', 'Edit', 'NotebookEdit'].includes(block.name) &&
          block.input?.file_path) {
        files.add(block.input.file_path);
      }
    }
  }
  return [...files];
}

function runWorker() {
  const transcriptPath = process.env._WTD_TRANSCRIPT;
  const branch = process.env._WTD_BRANCH;
  const safe = process.env._WTD_SAFE;
  const logdir = process.env._WTD_LOGDIR;

  if (!transcriptPath || !branch || !logdir) return;

  const files = getChangedFiles(transcriptPath);

  const instr = 'Below is the tail of a Claude Code session transcript in JSONL. In ONE concise sentence (max ~20 words), summarize what the user most recently asked for and what was done in response. Reply with ONLY that sentence — no preamble, no quotes.';
  let body = '';
  try {
    const content = readFileSync(transcriptPath, 'utf8');
    body = content.slice(-16000);
  } catch {}

  let summary = '(summary unavailable)';
  try {
    const sdir = join(tmpdir(), 'worktree-log-summarizer');
    mkdirSync(sdir, { recursive: true });
    const result = spawnSync('claude', ['-p', '--model', 'haiku'], {
      input: `${instr}\n\n${body}\n`,
      env: { ...process.env, WORKTREE_LOG_HOOK: '1' },
      cwd: sdir,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    if (result.stdout) {
      summary = result.stdout.replace(/\n/g, ' ').trim() || '(summary unavailable)';
    }
  } catch {}

  mkdirSync(logdir, { recursive: true });
  const entry = JSON.stringify({ ts: Date.now(), branch, kind: 'done', summary, files });
  try { appendFileSync(join(logdir, `${safe}.jsonl`), entry + '\n'); } catch {}
}
