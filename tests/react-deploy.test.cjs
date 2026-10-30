'use strict';
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const bash = process.platform === 'win32' ? 'C:/Users/user/AppData/Local/Programs/Git/bin/bash.exe' : 'bash';
const posix = (value) => value.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/');
const old = `sha256:${'1'.repeat(64)}`; const candidate = `sha256:${'2'.repeat(64)}`;
const revision = 'a'.repeat(40); const image = `example/service@sha256:${'b'.repeat(64)}`;
const directories = [];
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const dir of directories) fs.rmSync(dir, {recursive: true, force: true});
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-deploy-'));
  directories.push(dir);
  const bin = path.join(dir, 'bin'); const stage = path.join(dir, '.candidate-42-1');
  fs.mkdirSync(bin); fs.mkdirSync(stage);
  const executable = (name, value) => { const file = path.join(bin, name); fs.writeFileSync(file, value); fs.chmodSync(file, 0o755); };
  fs.writeFileSync(path.join(dir, 'prod.yml'), 'original compose\n');
  fs.writeFileSync(path.join(dir, '.env.prod'), 'OLD=value\n');
  fs.writeFileSync(path.join(stage, 'compose.yml'), 'candidate compose\n');
  fs.writeFileSync(path.join(stage, '.env.prod'), 'NEW=value\n');
  fs.copyFileSync('scripts/deploy-react-remote.sh', path.join(stage, 'remote.sh'));
  fs.writeFileSync(path.join(dir, 'state'), old);
  executable('flock', '#!/usr/bin/env bash\nexit 0\n');
  executable('setsid', '#!/usr/bin/env bash\nexec "$@"\n');
  executable('curl', '#!/usr/bin/env bash\nprintf 200\n');
  executable('sleep', '#!/usr/bin/env bash\nif (( $1 > 5 )); then /usr/bin/sleep 1; fi\n');
  executable('docker', `#!/usr/bin/env bash
set -eu
if [[ $1 == inspect ]]; then
  if [[ $3 == *'.Image'* ]]; then cat "$FAKE_STATE"; elif [[ $3 == *'.Config.Env'* ]]; then echo APP_REVISION=${revision}; else echo 'true healthy'; fi
elif [[ $1 == image ]]; then
  if [[ $4 == *'.Id'* ]]; then echo '${candidate}'; elif [[ $4 == *'.Labels'* ]]; then echo '${revision}'; else echo APP_REVISION=${revision}; fi
elif [[ $1 == compose ]]; then
  if [[ $* == *'config --images'* ]]; then echo "$IMAGE_REF"; elif [[ $* == *' up '* ]]; then
    if [[ $* == *'rollback.override.yml'* ]]; then [[ \${FAIL_ROLLBACK:-0} != 1 ]] || exit 1; echo '${old}' > "$FAKE_STATE"; else echo '${candidate}' > "$FAKE_STATE"; fi
  fi
fi
`);
  const env = {...process.env, PATH: `${posix(bin)}:${process.env.PATH}`, FAKE_STATE: posix(path.join(dir, 'state')), DEPLOY_CURL_BIN: posix(path.join(bin, 'curl')), DEPLOY_SLEEP_BIN: posix(path.join(bin, 'sleep'))};
  const run = (action, overrides = {}) => spawnSync(bash, ['scripts/deploy-react-remote.sh', action, posix(dir), 'app', 'app-prod', image, 'http://127.0.0.1:8080/health', '1', '42-1', posix(stage), 'prod.yml', revision], {cwd: process.cwd(), env: {...env, ...overrides}, encoding: 'utf8'});
  return {dir, run};
}
test('activation waits for finalization and rejects a changed owner', () => {
  const f = fixture();
  try {
    const activate = f.run('activate'); assert.equal(activate.status, 0, activate.stdout + activate.stderr);
    assert.match(activate.stdout, /DEPLOY_RESULT=ACTIVATED/);
    assert.equal(fs.readFileSync(path.join(f.dir, '.deploy-marker'), 'utf8').trim(), '42-1');
    fs.writeFileSync(path.join(f.dir, '.deploy-marker'), '99-1\n');
    const conflict = f.run('finalize'); assert.notEqual(conflict.status, 0); assert.match(conflict.stdout, /MARKER_CONFLICT/);
    fs.writeFileSync(path.join(f.dir, '.deploy-marker'), '42-1\n');
    const finalized = f.run('finalize'); assert.equal(finalized.status, 0, finalized.stdout + finalized.stderr);
    assert.match(finalized.stdout, /DEPLOY_RESULT=SUCCESS/);
  } finally { /* Cleanup waits for detached watchdogs in the after hook. */ }
});
test('marker-owned rollback restores files and image and reports failure distinctly', () => {
  const f = fixture();
  const activate = f.run('activate'); assert.equal(activate.status, 0, activate.stdout + activate.stderr);
  const failure = f.run('rollback', {FAIL_ROLLBACK: '1'}); assert.equal(failure.status, 2); assert.match(failure.stdout, /ROLLBACK_FAILED/);
  const rollback = f.run('rollback'); assert.equal(rollback.status, 0, rollback.stdout + rollback.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, '.env.prod'), 'utf8'), 'OLD=value\n');
  assert.equal(fs.readFileSync(path.join(f.dir, 'prod.yml'), 'utf8'), 'original compose\n');
  assert.equal(fs.readFileSync(path.join(f.dir, 'state'), 'utf8').trim(), old);
  assert.equal(fs.existsSync(path.join(f.dir, 'compose.yml')), false);
});
test('detached watchdog restores an unfinalized activation after caller exits', async () => {
  const f = fixture();
  const activate = f.run('activate'); assert.equal(activate.status, 0, activate.stdout + activate.stderr);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(fs.existsSync(path.join(f.dir, '.deploy-marker')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'state'), 'utf8').trim(), old);
  assert.match(fs.readFileSync(path.join(f.dir, '.backup-42-1', 'watchdog.log'), 'utf8'), /DEPLOY_RESULT=ROLLED_BACK/);
});

test('real flock allows watchdog to recover when a Docker process hangs', {skip: process.platform === 'win32' ? 'real flock requires a Linux host' : false}, () => {
  const locate = spawnSync('sh', ['-c', 'command -v flock >/dev/null && command -v setsid >/dev/null && command -v bash >/dev/null && command -v timeout'], {encoding: 'utf8'});
  assert.equal(locate.status, 0, 'flock, setsid, bash and GNU timeout are required');
  const result = spawnSync('sh', ['tests/react-watchdog-real-lock.sh', process.cwd()], {
    encoding: 'utf8', timeout: 20000, env: {...process.env, REAL_TIMEOUT: locate.stdout.trim()},
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: real flock watchdog recovered/);
});
