# Reusable CI and production deployment

These private reusable workflows execute in the calling repository. Every caller must pin a reviewed full `ci-workflows` commit SHA. Configuring this repository alone does not enable a service workflow or production deployment.

## Interfaces

`spring-ci.yml` requires `service-profile`, `service-name`, `dockerfile`, and `compose-file`. The only valid service/profile pairs are `gateway/base`, `batch/batch`, `community/community-redis`, and `auth/auth-mysql`. It runs secret scanning, Gradle `verify`, profile-specific integration tests, report upload, a non-pushing Docker build, and synthetic production Compose rendering. Auth retains MySQL 8.0.42 migration and concurrency tests; Community retains Redis 7.4.9 and `redisIntegrationTest`.

Every service name is also bound to its exact `devnogi` caller repository. A repository cannot select another service's tag namespace or Release identity.

`node-ci.yml` accepts only `service-name: react` plus `dockerfile` and `compose-file`. It runs the repository secret scan, Node 20 `npm ci`, workflow contract tests, `npm run verify`, a non-pushing Docker build, and synthetic production Compose rendering.

`spring-prod.yml` and `node-prod.yml` add `health-timeout` and `platform`. The timeout must be 1–600 seconds and the platform must be `linux/amd64`. Both workflows accept only `push` or `workflow_dispatch` on `main`, repeat the appropriate CI gates against the exact deployment commit, publish the image, deploy its immutable digest, verify health and recovery, and create the repository GitHub Release only after deployment succeeds.

`compose-deploy.yml` remains separately callable for a pre-verified digest by the five application repositories only; each is fixed to prod2. It reads `PROD2_COMPOSE_SERVICE`, `PROD2_CONTAINER_NAME`, `PROD2_REMOTE_DIR`, `PROD2_HEALTH_URL`, and `PROD2_COMPOSE_FILE` from the caller's `production` Environment. It requires `PROD2_HOST`, `PROD2_USER`, `PROD2_SSH_PORT` (46232), `PROD2_SSH_PRIVATE_KEY`, `PROD2_HOST_FINGERPRINT`, and `PROD2_ENV_FILE`. The fingerprint must be independently authenticated and cross-checked before configuration. The environment file must contain the complete candidate environment without `IMAGE_REF`.

## Organization configuration

Define these GitHub Actions organization variables and grant only the five production repositories access:

- `DOCKERHUB_REPOSITORY=devanted/memonogi`
- `DOCKERHUB_USERNAME=devanted`

Define organization secret `DOCKERHUB_PUSH_TOKEN` with Docker Hub Read/Write permission and no Delete permission, again limited to the five production repositories. The prod2 host, user, port, private key and fingerprint are organization Secrets scoped to the callers; each repository's `production` Environment supplies its `PROD2_ENV_FILE` Secret and prod2 deployment Variables. Callers use `secrets: inherit`; the called jobs explicitly select the required values. GitHub Releases use the built-in `GITHUB_TOKEN`, so no PAT is required. Production callers must grant `contents: write`; the reusable workflow restricts that permission to its release job while all other jobs remain read-only.

## Version, image, and release contract

Spring versions come only from `./gradlew properties -q`; a trailing `-SNAPSHOT` is removed. React comes only from `package.json`. Every production version must be numeric `MAJOR.MINOR.PATCH`.

All five services publish to the single public image repository `devanted/memonogi` with exactly one immutable tag:

- `gateway-v<version>`
- `batch-v<version>`
- `community-v<version>`
- `auth-v<version>`
- `react-v<version>`

There is no mutable `latest`, `prod`, or commit-SHA alias. A new image is built once with Buildx and OCI source, revision, and version labels. If the version tag already exists, a retry is accepted only when the registry digest and OCI revision/version labels exactly match the current commit and version; otherwise the run fails without mutation. Deployment always uses `devanted/memonogi@sha256:<digest>`, never the tag.

After deployment and health verification, the workflow creates a GitHub Release in the calling service repository using the same tag and release name. Its body records the service, version, commit, image repository, and digest. A retry accepts an existing release only when its tag target, name, body, draft/prerelease flags, version, commit, and digest all match. A mismatch fails without updating the existing tag or release.

Docker Hub tag immutability is mandatory. The workflow accepts all-tag immutability or the complete exact RE2 rule set:

- `^gateway-v[0-9]+\.[0-9]+\.[0-9]+$`
- `^batch-v[0-9]+\.[0-9]+\.[0-9]+$`
- `^community-v[0-9]+\.[0-9]+\.[0-9]+$`
- `^auth-v[0-9]+\.[0-9]+\.[0-9]+$`
- `^react-v[0-9]+\.[0-9]+\.[0-9]+$`

The workflow validates but never changes Docker Hub repository settings. Publication is serialized by caller repository, service, and version.

## Deployment and recovery

The production host needs Bash, `flock`, Docker Compose v2, and curl. The SSH user needs Docker access and write access to the configured deployment directory. The candidate Compose target service must use `${IMAGE_REF:?IMAGE_REF is required}`.

Before authentication, the workflow scans a single Ed25519 host key, checks its SHA-256 fingerprint against the independently authenticated secret, and uses the matching key in an ephemeral strict OpenSSH host-key file. It removes the runner files on exit. The workflow stages the candidate Compose and `.env.prod`, locks the deployment directory, stores the current Compose, environment, filename, and running image ID, then writes an execution marker. It replaces only the target service using `docker compose up -d --pull never --no-deps`. It verifies the exact image ID, Docker health when present, and the localhost HTTP endpoint. On failure, only the marker owner restores the saved files and image ID and verifies recovery. Rollback failure exits distinctly. Successful deployment removes the marker; timestamped backups remain available to operators.

## Development

The generated production workflows embed the scripts from `scripts/` so they can run in the caller repository without checking out this private repository. After changing a script or reusable CI workflow, run `node scripts/generate.cjs`, then `npm run verify`. Also run `actionlint` and Bash syntax checks when available. Docker builds, registry access, SSH, GitHub Release creation, and live service integration require their respective external environments and are not exercised by the offline test suite.
