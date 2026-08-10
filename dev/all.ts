// One command to boot the whole local stack: `bun run dev`.
//
//   1. bring up the Postgres container (docker compose)
//   2. migrate + seed it (schema + the Acme/Beta demo stores on *.localhost)
//   3. run all three long-lived processes together, with prefixed/colored logs:
//        storefront  → edge :8080  + origin :9090   (dev/server.ts)
//        admin-api   → :8787                          (apps/admin-api/src/server.ts)
//        admin-web   → :5173                          (vite)
//
// Ctrl-C stops all three cleanly. The DB container is left running (stop it with `bun run db:down`).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
};

function step(msg: string): void {
  console.log(`${c.dim}▸ ${msg}${c.reset}`);
}

// A blocking step; exits the whole command if it fails (a broken DB/schema means the apps can't run).
function must(label: string, cmd: string, args: string[], opts: { retries?: number } = {}): void {
  const retries = opts.retries ?? 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.status === 0) return;
    if (attempt < retries) {
      console.log(`${c.dim}  ${label} not ready, retrying (${attempt + 1}/${retries})…${c.reset}`);
      spawnSync('sleep', ['1']);
    }
  }
  console.error(`${c.red}✗ ${label} failed — is Docker running?${c.reset}`);
  process.exit(1);
}

step('starting Postgres (docker compose)');
must('db:up', 'docker', ['compose', 'up', '-d']);
// The container reports "up" before Postgres accepts connections; migrate is the readiness probe.
step('applying schema + seed');
must('migrate', 'bun', ['run', 'migrate'], { retries: 15 });
must('seed', 'bun', ['run', 'seed'], { retries: 3 });

// ── the three services ───────────────────────────────────────────────────────────────────────
const children: ChildProcess[] = [];
let shuttingDown = false;

function prefix(label: string, color: string, chunk: Buffer, out: NodeJS.WriteStream): void {
  const tag = `${color}[${label}]${c.reset} `;
  for (const line of chunk.toString().split('\n')) {
    if (line.length) out.write(tag + line + '\n');
  }
}

function service(label: string, color: string, cmd: string, args: string[]): void {
  // RATIO_LOCAL makes onboarding register the *.localhost alias and the admin use dev-insecure auth.
  const child = spawn(cmd, args, { env: { ...process.env, RATIO_LOCAL: 'true' } });
  child.stdout.on('data', (d: Buffer) => prefix(label, color, d, process.stdout));
  child.stderr.on('data', (d: Buffer) => prefix(label, color, d, process.stderr));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`${color}[${label}]${c.reset} exited (${code}) — shutting the stack down`);
    shutdown(1);
  });
  children.push(child);
}

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

step('starting storefront (:8080/:9090), admin-api (:8787), admin-web (:5173)\n');
service('storefront', c.cyan, 'node', [
  '--env-file-if-exists=apps/origin/.env',
  '--import',
  'tsx',
  'dev/server.ts',
]);
service('admin-api', c.green, 'node', [
  '--env-file-if-exists=apps/admin-api/.env',
  '--import',
  'tsx',
  'apps/admin-api/src/server.ts',
]);
service('admin-web', c.magenta, 'bun', ['run', '--cwd', 'apps/admin-web', 'dev']);
