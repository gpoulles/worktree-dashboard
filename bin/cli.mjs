#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { spawn } from 'child_process';
import { createServer } from '../src/server.mjs';

const VERSION = '0.1.0';

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

function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
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
