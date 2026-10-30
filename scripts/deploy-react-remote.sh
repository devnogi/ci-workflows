#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

action=$1; dir=$2; service=$3; container=$4; image=$5; url=$6; timeout=$7; run=$8; stage=$9; legacy_compose=${10}; revision=${11}
curl_bin=${DEPLOY_CURL_BIN:-curl}; sleep_bin=${DEPLOY_SLEEP_BIN:-sleep}
[[ $action == activate || $action == activate-guarded || $action == finalize || $action == finalize-guarded || $action == rollback || $action == rollback-guarded || $action == watchdog ]] || exit 1
[[ $dir =~ ^/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+$ && $service =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && $container =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 1
[[ $image =~ ^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ && $revision =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ $url =~ ^http://127\.0\.0\.1:[1-9][0-9]{0,4}/[a-zA-Z0-9/_-]*$ && $timeout =~ ^[1-9][0-9]{0,2}$ && $timeout -le 600 ]] || exit 1
[[ $run =~ ^[0-9]+-[0-9]+$ && $stage == "$dir/.candidate-$run" && $legacy_compose =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$ ]] || exit 1
backup="$dir/.backup-$run"
# Every operation that can own the lock runs in a bounded process group. Its
# wrapper remains outside that group so it can report a killed rollback.
if [[ $action == activate || $action == finalize || $action == rollback ]]; then
  script="$backup/remote.sh"
  [[ $action != activate ]] || script="$stage/remote.sh"
  [[ -f $script ]] || { [[ $action != rollback ]] || echo 'DEPLOY_RESULT=ROLLBACK_FAILED'; exit 2; }
  set +e
  timeout --signal=KILL "$((timeout * 2 + 60))s" bash "$script" "$action-guarded" "$dir" "$service" "$container" "$image" "$url" "$timeout" "$run" "$stage" "$legacy_compose" "$revision"
  result=$?
  set -e
  if [[ $result == 124 || $result == 137 ]]; then
    if [[ $action == rollback ]]; then echo 'DEPLOY_RESULT=ROLLBACK_FAILED'; exit 2; fi
    echo 'DEPLOY_RESULT=ACTION_TIMEOUT'; exit 1
  fi
  exit "$result"
fi
if [[ $action == watchdog ]]; then
  [[ -d $backup ]] || exit 1
  : > "$backup/watchdog-ready"
  "$sleep_bin" "$((timeout * 2 + 90))"
  exec bash "$backup/remote.sh" rollback "$dir" "$service" "$container" "$image" "$url" "$timeout" "$run" "$stage" "$legacy_compose" "$revision"
fi
cd "$dir"
exec 9>.deploy.lock
if [[ ${DEPLOY_WATCHDOG:-} == 1 ]]; then flock 9; else flock -w 30 9 || { echo 'DEPLOY_RESULT=LOCK_FAILED'; exit 2; }; fi

health() {
  local expected=$1 actual status code deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    actual=$(docker inspect --format '{{.Image}}' "$container" 9>&- 2>/dev/null) || actual=''
    status=$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 9>&- 2>/dev/null) || status=''
    if [[ $actual == "$expected" && ( $status == 'true healthy' || $status == 'true none' ) ]]; then
      code=$("$curl_bin" --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 5 "$url" 2>/dev/null) || code=''
      [[ $code == 200 ]] && return 0
    fi
    "$sleep_bin" 5
  done
  return 1
}
owned() { [[ -f .deploy-marker && $(<.deploy-marker) == "$run" && -f $backup/image-id && -f $backup/compose-name ]]; }
rollback() {
  owned || { echo 'Rollback refused: marker ownership changed'; return 1; }
  local original previous
  original=$(<"$backup/compose-name"); previous=$(<"$backup/image-id")
  [[ $original =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$ && $previous =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  cp "$backup/compose.original" "$original" && cp "$backup/env.original" .env.prod || return 1
  if [[ ! -f $backup/canonical-existed ]]; then rm -f compose.yml || return 1; fi
  IMAGE_REF="$previous" docker compose --project-directory "$dir" --env-file .env.prod -f "$original" -f "$backup/rollback.override.yml" up -d --pull never --no-deps "$service" 9>&- || return 1
  health "$previous" || return 1
  rm -f .deploy-marker || return 1
  echo 'DEPLOY_RESULT=ROLLED_BACK'
}

if [[ $action == rollback-guarded ]]; then
  if [[ ! -f .deploy-marker && ${DEPLOY_WATCHDOG:-} == 1 ]]; then exit 0; fi
  if rollback; then exit 0; else echo 'DEPLOY_RESULT=ROLLBACK_FAILED'; exit 2; fi
fi
if [[ $action == finalize-guarded ]]; then
  owned || { echo 'DEPLOY_RESULT=MARKER_CONFLICT'; exit 1; }
  expected=$(<"$backup/candidate-image-id")
  health "$expected" || { echo 'DEPLOY_RESULT=FINALIZE_FAILED'; exit 1; }
  rm -f .deploy-marker
  echo 'DEPLOY_RESULT=SUCCESS'
  exit 0
fi

trap 'rm -rf "$stage"' EXIT
[[ ! -e .deploy-marker && ! -e $backup && -f "$stage/compose.yml" && -f "$stage/.env.prod" && -f "$stage/remote.sh" && -f .env.prod ]] || { echo 'Required state absent or deployment already pending'; exit 1; }
if [[ -f compose.yml ]]; then original=compose.yml; elif [[ -f $legacy_compose ]]; then original=$legacy_compose; else exit 1; fi
previous=$(docker inspect --format '{{.Image}}' "$container" 9>&-)
[[ $previous =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
if grep -Eq '^\s*(export\s+)?(IMAGE_REF|APP_REVISION)\s*=' "$stage/.env.prod"; then echo 'Candidate environment contains reserved value'; exit 1; fi
printf '\nIMAGE_REF=%s\n' "$image" >> "$stage/.env.prod"
compose_candidate() { IMAGE_REF="$image" docker compose --project-directory "$dir" --env-file "$stage/.env.prod" -f "$stage/compose.yml" "$@" 9>&-; }
[[ $(compose_candidate config --images "$service") == "$image" ]] || exit 1
mkdir "$backup"
cp "$original" "$backup/compose.original"; cp .env.prod "$backup/env.original"; cp "$stage/remote.sh" "$backup/remote.sh"
printf '%s\n' "$original" > "$backup/compose-name"; printf '%s\n' "$previous" > "$backup/image-id"
if [[ $original == compose.yml ]]; then touch "$backup/canonical-existed"; fi
printf 'services:\n  %s:\n    image: %s\n' "$service" "$previous" > "$backup/rollback.override.yml"
# Launch the detached recovery process before creating the marker. It waits for
# the public verification deadline and obtains the same lock before recovery.
DEPLOY_WATCHDOG=1 setsid nohup bash "$backup/remote.sh" watchdog "$dir" "$service" "$container" "$image" "$url" "$timeout" "$run" "$stage" "$legacy_compose" "$revision" >"$backup/watchdog.log" 2>&1 </dev/null 9>&- &
for ((attempt=0; attempt<50; attempt++)); do
  [[ -f $backup/watchdog-ready ]] && break
  sleep 0.1
done
[[ -f $backup/watchdog-ready ]] || { echo 'Recovery watchdog did not start'; exit 1; }
printf '%s\n' "$run" > .deploy-marker
failure() { trap - ERR HUP INT TERM; if rollback; then exit 1; else echo 'DEPLOY_RESULT=ROLLBACK_FAILED'; exit 2; fi; }
trap failure ERR HUP INT TERM
compose_candidate pull "$service"
candidate=$(docker image inspect --format '{{.Id}}' "$image" 9>&-)
label=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image" 9>&-)
image_revision=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" 9>&- | sed -n 's/^APP_REVISION=//p')
[[ $candidate =~ ^sha256:[a-f0-9]{64}$ && $label == "$revision" && $image_revision == "$revision" ]]
printf '%s\n' "$candidate" > "$backup/candidate-image-id"
cp "$stage/compose.yml" compose.yml; cp "$stage/.env.prod" .env.prod
IMAGE_REF="$image" docker compose --project-directory "$dir" --env-file .env.prod -f compose.yml up -d --pull never --no-deps "$service" 9>&-
container_revision=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" 9>&- | sed -n 's/^APP_REVISION=//p')
[[ $container_revision == "$revision" ]]
health "$candidate"
trap - ERR HUP INT TERM
echo 'DEPLOY_RESULT=ACTIVATED'
