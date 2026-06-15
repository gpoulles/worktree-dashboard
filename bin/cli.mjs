#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createServer } from '../src/server.mjs';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) args.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--logo' && argv[i + 1]) args.logo = argv[++i];
    else if (argv[i] === '--title' && argv[i + 1]) args.title = argv[++i];
    else if (argv[i] === '--worktrees' && argv[i + 1]) args.worktrees = argv[++i];
    else if (argv[i] === '--config' && argv[i + 1]) args.configPath = argv[++i];
  }
  return args;
}

function loadFileConfig(configPath) {
  const filePath = configPath || join(process.cwd(), '.worktree-dashboard.json');
  if (existsSync(filePath)) {
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`Warning: failed to parse config file: ${e.message}`);
    }
  }
  return {};
}

function normalizeRunConfig(run) {
  if (!run) return null;
  return {
    scripts: Array.isArray(run.scripts) && run.scripts.length ? run.scripts : ['start'],
    command: typeof run.command === 'string' ? run.command : 'npm run {script} -- --port {port}',
    basePort: Number.isInteger(run.basePort) ? run.basePort : 4200,
  };
}

function loadLogo(logoPath) {
  if (!logoPath) return null;
  const resolved = resolve(process.cwd(), logoPath);
  if (!existsSync(resolved)) return null;
  const ext = resolved.split('.').pop().toLowerCase();
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
  const mime = mimeMap[ext] || 'image/png';
  const data = readFileSync(resolved).toString('base64');
  return `data:${mime};base64,${data}`;
}

// ── `init` command ──────────────────────────────────────────────────────────
// Install the prompt-logging hooks into the current project so the dashboard can
// show "what each worktree is working on". The dashboard only READS the logs in
// `.worktree-logs/`; these Claude Code hooks are what create and write them.
const HOOK_FILES = ['log-prompt-start.mjs', 'log-prompt.mjs'];
const HOOK_EVENTS = {
  UserPromptSubmit: '$CLAUDE_PROJECT_DIR/.claude/hooks/log-prompt-start.mjs',
  Stop: '$CLAUDE_PROJECT_DIR/.claude/hooks/log-prompt.mjs',
};

// Ensure settings.hooks[event] contains a command entry, without clobbering any
// existing hooks (including a previous run of this command).
function ensureHook(settings, event, command) {
  settings.hooks ??= {};
  const groups = (settings.hooks[event] ??= []);
  const already = groups.some(g => (g.hooks ?? []).some(h => h.command === command));
  if (already) return false;
  groups.push({ hooks: [{ type: 'command', command }] });
  return true;
}

function ensureGitignore(target) {
  const file = join(target, '.gitignore');
  const entry = '.worktree-logs/';
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (existing.split('\n').some(l => l.trim() === entry)) return false;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(file, `${existing}${prefix}${entry}\n`);
  return true;
}

function init() {
  const target = process.cwd();
  const srcHooks = join(PKG_ROOT, '.claude/hooks');
  const destHooks = join(target, '.claude/hooks');

  if (!existsSync(join(srcHooks, HOOK_FILES[0]))) {
    console.error(`  ✗ Could not find bundled hooks at ${srcHooks}`);
    process.exit(1);
  }

  mkdirSync(destHooks, { recursive: true });
  for (const f of HOOK_FILES) {
    copyFileSync(join(srcHooks, f), join(destHooks, f));
    chmodSync(join(destHooks, f), 0o755);
  }
  console.log(`  ✓ Installed hooks → ${join('.claude', 'hooks')}/`);

  const settingsPath = join(target, '.claude/settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      console.error(`  ✗ Could not parse ${settingsPath}: ${e.message}`);
      console.error('    Fix or remove it, then re-run `worktree-dashboard init`.');
      process.exit(1);
    }
  }
  let added = false;
  for (const [event, command] of Object.entries(HOOK_EVENTS)) {
    added = ensureHook(settings, event, command) || added;
  }
  if (added) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`  ✓ Wired hooks into ${join('.claude', 'settings.json')}`);
  } else {
    console.log(`  • Hooks already wired in ${join('.claude', 'settings.json')}`);
  }

  if (ensureGitignore(target)) console.log('  ✓ Added .worktree-logs/ to .gitignore');

  console.log('\n  Prompt logging is set up. Notes:');
  console.log('    • Requires the `claude` CLI on your PATH (summaries use Claude Haiku).');
  console.log('    • Restart any running Claude Code session to pick up the new hooks.');
  console.log('    • Logs land in .worktree-logs/ in your main checkout.\n');
}

function openBrowser(url) {
  try {
    const procVersion = readFileSync('/proc/version', 'utf8').toLowerCase();
    if (procVersion.includes('microsoft')) {
      spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
      return;
    }
  } catch {}
  const platform = process.platform;
  if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' });
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  }
}

function printHelp() {
  console.log(`
  Worktree Dashboard (v${VERSION})

  Usage:
    worktree-dashboard [options]    Start the dashboard (default)
    worktree-dashboard init         Install prompt-logging hooks into this project
    worktree-dashboard --help       Show this help

  Options:
    --port <n>          Port to listen on (default 3333)
    --title <text>      Dashboard title
    --worktrees <path>  Worktrees directory (default .claude/worktrees)
    --logo <path>       Path to a logo image
    --config <path>     Path to a .worktree-dashboard.json config file
`);
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === 'init') return init();
  if (command === '--help' || command === '-h' || command === 'help') return printHelp();

  const cliArgs = parseArgs(argv);
  const fileConfig = loadFileConfig(cliArgs.configPath);

  const config = {
    port: cliArgs.port ?? fileConfig.port ?? 3333,
    title: cliArgs.title ?? fileConfig.title ?? 'Worktree Dashboard',
    worktrees: cliArgs.worktrees ?? fileConfig.worktrees ?? '.claude/worktrees',
    logo: loadLogo(cliArgs.logo ?? fileConfig.logo),
    run: normalizeRunConfig(fileConfig.run),
    templates: fileConfig.templates ?? [],
    cwd: process.cwd(),
    version: VERSION,
  };

  const server = createServer(config);
  server.listen(config.port, '127.0.0.1', () => {
    const url = `http://localhost:${config.port}`;
    console.log(`\n  🌳 Worktree Dashboard is up and running! (v${VERSION})`);
    console.log(`\n  Open it in your browser: ${url}`);
    console.log(`  Keeping an eye on ${config.worktrees}/ for you.`);
    console.log('\n  All set — press Ctrl+C whenever you want to stop.\n');
    openBrowser(url);
  });

  process.on('SIGINT', () => {
    console.log('\n  👋 Thanks for stopping by — shutting down. See you next time!\n');
    server.close();
    process.exit(0);
  });
}

main();
