'use strict';

const {execFileSync, spawnSync} = require('node:child_process');

function required(env, key) {
  if (!env[key] || !env[key].trim()) throw Error(`Missing ${key}`);
  return env[key];
}

function validateInputs(env) {
  if (env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw Error('Production requires a main push or dispatch');
  }
  if (!/^[a-f0-9]{40}$/.test(required(env, 'GITHUB_SHA'))) throw Error('Invalid commit');
  if (!/^https:\/\/github\.com$/.test(required(env, 'GITHUB_SERVER_URL'))) throw Error('Invalid GitHub server');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(required(env, 'GITHUB_REPOSITORY'))) throw Error('Invalid caller repository');
  if (!['base', 'auth-mysql', 'community-redis', 'batch'].includes(required(env, 'SERVICE_PROFILE'))) throw Error('Invalid profile');
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(required(env, 'IMAGE_NAME'))) throw Error('Invalid image name');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ya?ml$/.test(required(env, 'COMPOSE_FILE')) || env.COMPOSE_FILE.includes('..')) throw Error('Invalid compose path');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(required(env, 'DOCKERFILE')) || env.DOCKERFILE.includes('..')) throw Error('Invalid Dockerfile path');
  if (!/^[1-9][0-9]{0,2}$/.test(required(env, 'HEALTH_TIMEOUT')) || +env.HEALTH_TIMEOUT > 600) throw Error('Invalid health timeout');
  if (required(env, 'PLATFORM') !== 'linux/amd64') throw Error('Invalid platform');
}

function validatePublishSecrets(env) {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(required(env, 'DOCKERHUB_NAMESPACE'))) throw Error('Invalid Docker Hub namespace');
  required(env, 'DOCKERHUB_PUSH_TOKEN');
}

function validateDeploymentSettings(env) {
  for (const key of ['COMPOSE_SERVICE', 'CONTAINER_NAME']) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(required(env, key))) throw Error(`Invalid ${key}`);
  }
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(required(env, 'REMOTE_DIR'))) throw Error('Invalid remote directory');
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-zA-Z0-9/_-]*$/.test(required(env, 'HEALTH_URL')) || +new URL(env.HEALTH_URL).port > 65535) throw Error('Invalid health URL');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$/.test(required(env, 'PROD_COMPOSE_FILE'))) throw Error('Invalid production Compose filename');
}

function validateDeploymentSecrets(env) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(required(env, 'PROD_HOST'))) throw Error('Invalid production host');
  if (!/^[a-z_][a-z0-9_-]*$/.test(required(env, 'PROD_USER'))) throw Error('Invalid production user');
  if (!/^[1-9][0-9]{0,4}$/.test(required(env, 'PROD_SSH_PORT')) || +env.PROD_SSH_PORT > 65535) throw Error('Invalid production SSH port');
  for (const key of ['PROD_SSH_PRIVATE_KEY', 'PROD_KNOWN_HOSTS', 'PROD_ENV_FILE']) required(env, key);
  if (/^\s*(?:export\s+)?IMAGE_REF\s*=/m.test(env.PROD_ENV_FILE)) throw Error('PROD_ENV_FILE must not set IMAGE_REF');
}

function version(value) {
  const release = value.trim().replace(/-SNAPSHOT$/, '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release)) throw Error('Invalid Gradle version');
  return release;
}

function collision(versionDigest, shaDigest) {
  if (versionDigest === null && shaDigest === null) return 'build';
  if (versionDigest && shaDigest && versionDigest === shaDigest && /^sha256:[a-f0-9]{64}$/.test(versionDigest)) return 'reuse';
  throw Error('Conflicting or incomplete existing tags');
}

function immutableTagsRequired(info, tags) {
  if (!info || info.is_private !== false) throw Error('Public Docker Hub repository required');
  const settings = info.immutable_tags_settings;
  if (!settings || settings.enabled !== true || !Array.isArray(settings.rules)) throw Error('Docker Hub immutable tags are required');
  if (settings.rules.length === 0) return;
  if (!Array.isArray(tags) || tags.length !== 2) throw Error('Published tags are required for immutable-rule validation');
  const [versionTag, shaTag] = tags;
  if (!/^prod-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(versionTag) || !/^sha-[a-f0-9]{40}$/.test(shaTag)) {
    throw Error('Unexpected published tag format');
  }
  const allTags = settings.rules.includes('.*') || settings.rules.includes('^.*$');
  const versionRule = settings.rules.includes('^prod-v[0-9]+\\.[0-9]+\\.[0-9]+$');
  const shaRule = settings.rules.includes('^sha-[0-9a-f]{40}$');
  if (!allTags && !(versionRule && shaRule)) {
    throw Error('Use all-tag immutability or the documented exact production and SHA rules');
  }
}

function resolveVersion(env, deps = {}) {
  const gradle = deps.execFileSync || execFileSync;
  const fs = deps.fs || require('node:fs');
  let output;
  try {
    output = gradle('./gradlew', ['properties', '-q'], {encoding: 'utf8'});
  } catch {
    throw Error('Gradle version resolution failed');
  }
  const matches = [...output.matchAll(/^version:\s*(.+)$/gm)];
  if (matches.length !== 1) throw Error('Cannot resolve root Gradle version');
  const release = version(matches[0][1]);
  fs.appendFileSync(env.GITHUB_OUTPUT, `version=${release}\n`);
  return release;
}

async function hub(path, token, request) {
  const response = await request(`https://hub.docker.com/v2/${path}`, {
    headers: {Authorization: `Bearer ${token}`},
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw Error(`Docker Hub request failed (${response.status})`);
  return response.json();
}

function command(name, args) {
  try {
    execFileSync(name, args, {stdio: 'ignore'});
  } catch {
    throw Error('Docker command failed');
  }
}

async function publish(env, deps = {}) {
  validateInputs(env);
  validatePublishSecrets(env);
  validateDeploymentSettings(env);
  validateDeploymentSecrets(env);
  const request = deps.fetch || fetch;
  const run = deps.cmd || command;
  const login = deps.spawnSync || spawnSync;
  const fs = deps.fs || require('node:fs');
  const release = version(required(env, 'RELEASE_VERSION'));
  const sha = env.GITHUB_SHA;
  const namespace = env.DOCKERHUB_NAMESPACE;
  const repository = env.IMAGE_NAME;
  const image = `${namespace}/${repository}`;
  const versionTag = `prod-v${release}`;
  const shaTag = `sha-${sha}`;

  const auth = await request('https://hub.docker.com/v2/auth/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({identifier: namespace, secret: env.DOCKERHUB_PUSH_TOKEN}),
    signal: AbortSignal.timeout(30000),
  });
  if (!auth.ok) throw Error(`Docker Hub authentication failed (${auth.status})`);
  const token = (await auth.json()).access_token;
  if (!token) throw Error('Docker Hub token missing');

  const info = await hub(`namespaces/${namespace}/repositories/${repository}`, token, request);
  immutableTagsRequired(info, [versionTag, shaTag]);
  const readDigest = async (tag) => {
    const tagInfo = await hub(`namespaces/${namespace}/repositories/${repository}/tags/${tag}`, token, request);
    return tagInfo ? tagInfo.digest : null;
  };

  let versionDigest = await readDigest(versionTag);
  let shaDigest = await readDigest(shaTag);
  const state = collision(versionDigest, shaDigest);
  let digest;
  if (state === 'reuse') {
    digest = versionDigest;
  } else {
    const loginResult = login('docker', ['login', '--username', namespace, '--password-stdin'], {
      input: env.DOCKERHUB_PUSH_TOKEN,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    if (loginResult.status !== 0) throw Error('Docker login failed');
    if (await readDigest(versionTag) !== null || await readDigest(shaTag) !== null) throw Error('Tag appeared before publication');

    const metadataFile = `${env.RUNNER_TEMP}/build-metadata.json`;
    run('docker', [
      'buildx', 'build', '--push',
      '--platform', env.PLATFORM,
      '--file', env.DOCKERFILE,
      '--tag', `${image}:${versionTag}`,
      '--tag', `${image}:${shaTag}`,
      '--label', `org.opencontainers.image.revision=${sha}`,
      '--label', `org.opencontainers.image.source=${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`,
      '--label', `org.opencontainers.image.version=${release}`,
      '--metadata-file', metadataFile,
      '.',
    ]);
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    } catch {
      throw Error('Buildx metadata unavailable');
    }
    digest = metadata['containerimage.digest'];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw Error('Buildx digest unavailable');
    versionDigest = await readDigest(versionTag);
    shaDigest = await readDigest(shaTag);
    if (versionDigest !== digest || shaDigest !== digest) throw Error('Registry digest does not match Buildx output');
  }

  fs.appendFileSync(env.GITHUB_OUTPUT, `version=${release}\ndigest=${digest}\n`);
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `Service: ${env.COMPOSE_SERVICE}\n\nVersion: ${release}\n\nCommit: ${sha}\n\nDigest: ${digest}\n`);
}

module.exports = {collision, immutableTagsRequired, publish, resolveVersion, validateDeploymentSecrets, validateDeploymentSettings, validateInputs, validatePublishSecrets, version};

if (require.main === module || process.argv[1] === '-') {
  const mode = process.argv[2];
  Promise.resolve()
    .then(() => {
      if (mode === 'validate-inputs') return validateInputs(process.env);
      if (mode === 'resolve-version') return resolveVersion(process.env);
      if (mode === 'publish') return publish(process.env);
      throw Error('Invalid mode');
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
