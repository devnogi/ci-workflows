'use strict';

const {execFileSync, spawnSync} = require('node:child_process');

const serviceProfiles = Object.freeze({
  gateway: 'base',
  batch: 'batch',
  community: 'community-redis',
  auth: 'auth-mysql',
  react: 'react',
});
const serviceRepositories = Object.freeze({
  gateway: 'devnogi/devnogi-gateway-server',
  batch: 'devnogi/open-api-batch-server',
  community: 'devnogi/devnogi-community-server',
  auth: 'devnogi/devnogi-auth-server',
  react: 'devnogi/devnogi-react',
});
const immutableVersionRules = Object.freeze(Object.keys(serviceProfiles).map(
  (service) => `^${service}-v[0-9]+\\.[0-9]+\\.[0-9]+$`,
));

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
  const service = required(env, 'SERVICE_NAME');
  const profile = required(env, 'SERVICE_PROFILE');
  if (required(env, 'DEPLOYMENT_TARGET') !== 'prod2') throw Error('Invalid deployment target');
  if (!Object.hasOwn(serviceProfiles, service) || serviceProfiles[service] !== profile) throw Error('Invalid service profile mapping');
  if (serviceRepositories[service] !== env.GITHUB_REPOSITORY) throw Error('Caller repository does not match service');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ya?ml$/.test(required(env, 'COMPOSE_FILE')) || env.COMPOSE_FILE.includes('..')) throw Error('Invalid compose path');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(required(env, 'DOCKERFILE')) || env.DOCKERFILE.includes('..')) throw Error('Invalid Dockerfile path');
  if (!/^[1-9][0-9]{0,2}$/.test(required(env, 'HEALTH_TIMEOUT')) || +env.HEALTH_TIMEOUT > 600) throw Error('Invalid health timeout');
  if (required(env, 'PLATFORM') !== 'linux/amd64') throw Error('Invalid platform');
}

function validatePublishSecrets(env) {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(required(env, 'DOCKERHUB_USERNAME'))) throw Error('Invalid Docker Hub username');
  if (required(env, 'DOCKERHUB_REPOSITORY') !== 'devanted/memonogi') throw Error('Invalid Docker Hub repository');
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
  if (!Object.values(serviceRepositories).includes(required(env, 'GITHUB_REPOSITORY'))) throw Error('Invalid deployment caller');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(required(env, 'PROD2_HOST'))) throw Error('Invalid production host');
  if (!/^[a-z_][a-z0-9_-]*$/.test(required(env, 'PROD2_USER'))) throw Error('Invalid production user');
  if (required(env, 'PROD2_SSH_PORT') !== '46232') throw Error('Invalid production SSH port');
  if (!/^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/.test(required(env, 'PROD2_HOST_FINGERPRINT'))) throw Error('Invalid production fingerprint');
  for (const key of ['PROD2_SSH_PRIVATE_KEY', 'PROD2_ENV_FILE']) required(env, key);
  if (/^\s*(?:export\s+)?IMAGE_REF\s*=/m.test(env.PROD2_ENV_FILE)) throw Error('PROD2_ENV_FILE must not set IMAGE_REF');
}

function version(value, allowSnapshot = true) {
  const release = allowSnapshot ? value.trim().replace(/-SNAPSHOT$/, '') : value.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release)) throw Error('Invalid release version');
  return release;
}

function collision(versionDigest) {
  if (versionDigest === null) return 'build';
  if (/^sha256:[a-f0-9]{64}$/.test(versionDigest)) return 'verify-reuse';
  throw Error('Invalid existing tag digest');
}

function verifyArtifactRevision(currentSha, artifactRevision, deps = {}) {
  if (!/^[a-f0-9]{40}$/.test(artifactRevision)) throw Error('Invalid existing image revision');
  if (artifactRevision === currentSha) return artifactRevision;
  const git = deps.gitExecFileSync || execFileSync;
  try {
    git('git', ['merge-base', '--is-ancestor', artifactRevision, currentSha], {stdio: 'ignore'});
  } catch {
    throw Error('Existing image revision is not an ancestor of this commit');
  }
  let commits;
  try {
    commits = git('git', ['rev-list', '--reverse', `${artifactRevision}..${currentSha}`], {encoding: 'utf8'}).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    throw Error('Cannot enumerate existing image recovery commits');
  }
  const allowed = (file) => file.startsWith('.github/workflows/') || file === 'scripts/workflow-contract.test.mjs';
  const normalizePins = (file, contents) => {
    if (file === 'scripts/workflow-contract.test.mjs') {
      return contents.replace(/(const pin = ')[a-f0-9]{40}(';)/g, '$1<sha>$2');
    }
    return contents.replace(/(devnogi\/ci-workflows\/\.github\/workflows\/(?:spring|node)-(?:ci|prod)\.yml@)[a-f0-9]{40}/g, '$1<sha>');
  };
  let changed = false;
  for (const commit of commits) {
    let parent;
    let paths;
    try {
      parent = git('git', ['rev-parse', `${commit}^1`], {encoding: 'utf8'}).trim();
      paths = git('git', ['diff', '--name-only', '-z', '--no-renames', parent, commit, '--'], {encoding: 'utf8'}).split(String.fromCharCode(0)).filter(Boolean);
    } catch {
      throw Error('Cannot verify deployment workflow pin changes');
    }
    if (paths.length === 0) continue;
    changed = true;
    if (paths.some((file) => !allowed(file))) throw Error('Existing image revision differs outside deployment workflow files');
    for (const file of paths) {
      let before;
      let after;
      try {
        before = git('git', ['show', `${parent}:${file}`], {encoding: 'utf8'});
        after = git('git', ['show', `${commit}:${file}`], {encoding: 'utf8'});
      } catch {
        throw Error('Existing image recovery cannot add, delete, or rename caller files');
      }
      if (before === after || normalizePins(file, before) !== normalizePins(file, after)) {
        throw Error('Existing image recovery may change only in-place shared workflow SHAs');
      }
    }
  }
  if (!changed) throw Error('Existing image recovery contains no workflow pin change');
  return artifactRevision;
}

function releaseCommit(env) {
  const commit = required(env, 'RELEASE_COMMIT').trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid release commit');
  return commit;
}

function immutableTagsRequired(info, tags) {
  if (!info || info.is_private !== true) throw Error('Private Docker Hub repository required');
  const settings = info.immutable_tags_settings;
  if (!settings || settings.enabled !== true || !Array.isArray(settings.rules)) throw Error('Docker Hub immutable tags are required');
  if (settings.rules.length === 0) return;
  if (!Array.isArray(tags) || tags.length !== 1) throw Error('Published tag is required for immutable-rule validation');
  if (!/^(?:gateway|batch|community|auth|react)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tags[0])) {
    throw Error('Unexpected published tag format');
  }
  const allTags = settings.rules.includes('.*') || settings.rules.includes('^.*$');
  if (!allTags && !immutableVersionRules.every((rule) => settings.rules.includes(rule))) {
    throw Error('Use all-tag immutability or every documented service version rule');
  }
}

function resolveGradleVersion(env, deps = {}) {
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

function resolveNpmVersion(env, deps = {}) {
  const fs = deps.fs || require('node:fs');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  } catch {
    throw Error('Cannot read package version');
  }
  const release = version(String(parsed.version || ''), false);
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

function capture(name, args) {
  try {
    return execFileSync(name, args, {encoding: 'utf8'}).trim();
  } catch {
    throw Error('Docker inspection failed');
  }
}

async function publish(env, deps = {}) {
  validateInputs(env);
  validatePublishSecrets(env);
  validateDeploymentSettings(env);
  validateDeploymentSecrets(env);
  const request = deps.fetch || fetch;
  const run = deps.cmd || command;
  const inspect = deps.capture || capture;
  const login = deps.spawnSync || spawnSync;
  const fs = deps.fs || require('node:fs');
  const release = version(required(env, 'RELEASE_VERSION'));
  const sha = env.GITHUB_SHA;
  const service = env.SERVICE_NAME;
  const username = env.DOCKERHUB_USERNAME;
  const image = env.DOCKERHUB_REPOSITORY;
  const [namespace, repository] = image.split('/');
  const versionTag = `${service}-v${release}`;

  const auth = await request('https://hub.docker.com/v2/auth/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({identifier: username, secret: env.DOCKERHUB_PUSH_TOKEN}),
    signal: AbortSignal.timeout(30000),
  });
  if (!auth.ok) throw Error(`Docker Hub authentication failed (${auth.status})`);
  const token = (await auth.json()).access_token;
  if (!token) throw Error('Docker Hub token missing');

  const info = await hub(`namespaces/${namespace}/repositories/${repository}`, token, request);
  immutableTagsRequired(info, [versionTag]);
  const readDigest = async (tag) => {
    const tagInfo = await hub(`namespaces/${namespace}/repositories/${repository}/tags/${tag}`, token, request);
    return tagInfo ? tagInfo.digest : null;
  };

  let versionDigest = await readDigest(versionTag);
  const state = collision(versionDigest);
  let digest;
  let artifactRevision = sha;
  const loginResult = login('docker', ['login', '--username', username, '--password-stdin'], {
    input: env.DOCKERHUB_PUSH_TOKEN,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (loginResult.status !== 0) throw Error('Docker login failed');

  if (state === 'verify-reuse') {
    run('docker', ['pull', `${image}:${versionTag}`]);
    const revision = inspect('docker', ['image', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', `${image}:${versionTag}`]);
    const imageVersion = inspect('docker', ['image', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.version" }}', `${image}:${versionTag}`]);
    const source = inspect('docker', ['image', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.source" }}', `${image}:${versionTag}`]);
    const repoDigests = JSON.parse(inspect('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', `${image}:${versionTag}`]));
    if (imageVersion !== release || source !== `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}` || !repoDigests.includes(`${image}@${versionDigest}`)) {
      throw Error('Existing tag does not match this commit and version');
    }
    artifactRevision = verifyArtifactRevision(sha, revision, deps);
    digest = versionDigest;
  } else {
    if (await readDigest(versionTag) !== null) throw Error('Tag appeared before publication');

    const metadataFile = `${env.RUNNER_TEMP}/build-metadata.json`;
    run('docker', [
      'buildx', 'build', '--push',
      '--platform', env.PLATFORM,
      '--file', env.DOCKERFILE,
      '--tag', `${image}:${versionTag}`,
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
    if (versionDigest !== digest) throw Error('Registry digest does not match Buildx output');
  }

  fs.appendFileSync(env.GITHUB_OUTPUT, `version=${release}\ndigest=${digest}\ntag=${versionTag}\ncommit=${artifactRevision}\n`);
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `Service: ${service}\n\nVersion: ${release}\n\nTag: ${versionTag}\n\nArtifact commit: ${artifactRevision}\n\nWorkflow commit: ${sha}\n\nDigest: ${digest}\n`);
}

function releaseBody(env) {
  const service = required(env, 'SERVICE_NAME');
  const release = version(required(env, 'RELEASE_VERSION'), false);
  const sha = releaseCommit(env);
  const digest = required(env, 'IMAGE_DIGEST');
  const image = required(env, 'DOCKERHUB_REPOSITORY');
  const tag = `${service}-v${release}`;
  const workflowSha = required(env, 'GITHUB_SHA');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw Error('Invalid image digest');
  return [
    `Service: ${service}`,
    `Version: ${release}`,
    `Artifact commit: ${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/commit/${sha}`,
    `Deployment workflow commit: ${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/commit/${workflowSha}`,
    `Image: ${image}@${digest}`,
    `Docker tag: ${image}:${tag}`,
  ].join('\n\n');
}

async function githubRelease(env, deps = {}) {
  validateInputs(env);
  const request = deps.fetch || fetch;
  const fs = deps.fs || require('node:fs');
  const token = required(env, 'GITHUB_TOKEN');
  const service = env.SERVICE_NAME;
  const release = version(required(env, 'RELEASE_VERSION'), false);
  const tag = `${service}-v${release}`;
  const tagCommit = required(env, 'GITHUB_SHA');
  const body = releaseBody(env);
  const api = required(env, 'GITHUB_API_URL');
  if (api !== 'https://api.github.com') throw Error('Invalid GitHub API URL');
  const base = `${api}/repos/${env.GITHUB_REPOSITORY}`;
  const call = async (path, options = {}) => {
    const response = await request(`${base}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw Error(`GitHub Release request failed (${response.status})`);
    return response.json();
  };
  const resolveTag = async () => {
    const ref = await call(`/git/ref/tags/${encodeURIComponent(tag)}`);
    if (!ref) return null;
    let object = ref.object;
    for (let depth = 0; depth < 5 && object.type === 'tag'; depth += 1) {
      const annotated = await call(`/git/tags/${object.sha}`);
      if (!annotated) throw Error('Annotated tag object missing');
      object = annotated.object;
    }
    if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw Error('Release tag does not resolve to a commit');
    return object.sha;
  };
  const verifyTagCommit = async (commit) => {
    if (commit === tagCommit) return;
    const comparison = await call(`/compare/${tagCommit}...${commit}`);
    if (!comparison || comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== tagCommit) {
      throw Error('Release tag is not the deployment commit or its descendant');
    }
  };
  const verify = async (existing) => {
    const commit = await resolveTag();
    await verifyTagCommit(commit);
    if (!existing || existing.tag_name !== tag || existing.name !== tag || existing.body !== body || existing.draft || existing.prerelease) {
      throw Error('Existing GitHub Release does not match deployed metadata');
    }
    return existing;
  };

  let existing = await call(`/releases/tags/${encodeURIComponent(tag)}`);
  if (existing) {
    existing = await verify(existing);
  } else {
    const commit = await resolveTag();
    if (commit) await verifyTagCommit(commit);
    existing = await call('/releases', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: tag,
        body,
        draft: false,
        prerelease: false,
        generate_release_notes: false,
        make_latest: 'true',
      }),
    });
    if (!existing) throw Error('GitHub Release creation returned no result');
    existing = await verify(existing);
  }
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `Release: ${existing.html_url}\n`);
  return existing;
}

module.exports = {collision, githubRelease, immutableTagsRequired, publish, releaseBody, releaseCommit, resolveGradleVersion, resolveNpmVersion, validateDeploymentSecrets, validateDeploymentSettings, validateInputs, validatePublishSecrets, verifyArtifactRevision, version};

if (require.main === module || process.argv[1] === '-') {
  const mode = process.argv[2];
  Promise.resolve()
    .then(() => {
      if (mode === 'validate-inputs') return validateInputs(process.env);
      if (mode === 'resolve-gradle-version') return resolveGradleVersion(process.env);
      if (mode === 'resolve-npm-version') return resolveNpmVersion(process.env);
      if (mode === 'publish') return publish(process.env);
      if (mode === 'github-release') return githubRelease(process.env);
      throw Error('Invalid mode');
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
