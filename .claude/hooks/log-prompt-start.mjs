#!/usr/bin/env node
// UserPromptSubmit hook — records the current prompt so the dashboard shows
// "what this worktree is working on" live during a Claude turn.

import { execSync } from 'child_process';
import { mkdirSync, appendFileSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';

// Don't fire inside the Stop hook's headless summarizer call.
if (process.env.WORKTREE_LOG_HOOK === '1') process.exit(0);

// Critical: UserPromptSubmit stdout is injected into Claude's context — never write to it.
process.stdout.write = () => true;
process.stderr.write = () => true;

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }

  const prompt = input.prompt ?? '';
  const cwd = input.cwd || process.cwd();
  if (!prompt) return;

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
  mkdirSync(logdir, { recursive: true });

  const compactPrompt = prompt.replace(/\n/g, ' ').slice(0, 500);
  const entry = JSON.stringify({ ts: Date.now(), branch, kind: 'start', prompt: compactPrompt });
  try { appendFileSync(join(logdir, `${safe}.jsonl`), entry + '\n'); } catch {}
}

main().catch(() => {});
