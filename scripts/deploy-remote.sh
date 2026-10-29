#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

dir=$1; service=$2; container=$3; image=$4; url=$5; timeout=$6; run=$7; stage=$8; legacy_compose=$9
curl_bin=${DEPLOY_CURL_BIN:-curl}
sleep_bin=${DEPLOY_SLEEP_BIN:-sleep}
[[ $dir =~ ^/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+$ && $service =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 1
[[ $container =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && $image =~ ^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || exit 1
[[ $url =~ ^http://127\.0\.0\.1:[1-9][0-9]{0,4}/[a-zA-Z0-9/_-]*$ && $timeout =~ ^[1-9][0-9]{0,2}$ && $timeout -le 600 ]] || exit 1
[[ $run =~ ^[0-9]+-[0-9]+$ && $stage == "$dir/.candidate-$run" && $legacy_compose =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$ ]] || exit 1
trap 'rm -rf "$stage"' EXIT
cd "$dir"
exec 9>.deploy.lock
flock -w 30 9 || exit 1
[[ -f "$stage/compose.yml" && -f "$stage/.env.prod" && -f .env.prod ]] || { echo 'Required current or candidate state absent'; exit 1; }

if [[ -f compose.yml ]]; then
  original_compose=compose.yml
elif [[ -f $legacy_compose ]]; then
  original_compose=$legacy_compose
else
  echo 'No existing production Compose file found'
  exit 1
fi

previous_image_id=$(docker inspect --format '{{.Image}}' "$container")
[[ $previous_image_id =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Running container image ID unavailable'; exit 1; }
if grep -Eq '^IMAGE_REF=' "$stage/.env.prod"; then echo 'Candidate environment must not define IMAGE_REF'; exit 1; fi
printf '\nIMAGE_REF=%s\n' "$image" >> "$stage/.env.prod"

compose_candidate() {
  IMAGE_REF="$image" docker compose --project-directory "$dir" --env-file "$stage/.env.prod" -f "$stage/compose.yml" "${@:1}"
}
[[ $(compose_candidate config --images "$service") == "$image" ]] || { echo 'Candidate image mismatch'; exit 1; }

health() {
  local expected_image_id=$1 actual_image_id status http_code deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    actual_image_id=$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null) || actual_image_id=''
    status=$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null) || status=''
    if [[ $actual_image_id == "$expected_image_id" ]]; then
      if [[ $status == 'true healthy' || $status == 'true none' ]]; then
        http_code=$("$curl_bin" --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 5 "$url" 2>/dev/null) || http_code=''
        if [[ $http_code == '200' ]]; then return 0; fi
      fi
    fi
    "$sleep_bin" 5
  done
  return 1
}

backup="$dir/.backup-$run"
[[ ! -e $backup ]] || exit 1
mkdir "$backup"
cp "$original_compose" "$backup/compose.original"
cp .env.prod "$backup/env.original"
printf '%s\n' "$original_compose" > "$backup/compose-name"
printf '%s\n' "$previous_image_id" > "$backup/image-id"
if [[ $original_compose == compose.yml ]]; then touch "$backup/canonical-existed"; fi
cat > "$backup/rollback.override.yml" <<EOF
services:
  $service:
    image: $previous_image_id
EOF
printf '%s\n' "$run" > .deploy-marker

rollback() {
  [[ -f .deploy-marker && $(cat .deploy-marker) == "$run" ]] || { echo 'Rollback refused: marker ownership changed'; return 1; }
  cp "$backup/compose.original" "$original_compose" || return 1
  cp "$backup/env.original" .env.prod || return 1
  if [[ ! -f $backup/canonical-existed ]]; then rm -f compose.yml || return 1; fi
  if ! docker compose --project-directory "$dir" --env-file .env.prod -f "$original_compose" -f "$backup/rollback.override.yml" up -d --pull never --no-deps "$service"; then
    echo 'Rollback service restore failed'
    return 1
  fi
  if ! health "$previous_image_id"; then
    echo 'Rollback image or health verification failed'
    return 1
  fi
  rm -f .deploy-marker || return 1
  echo 'Previous service image and health recovered'
}

handle_failure() {
  local original_status=$1
  trap - ERR HUP INT TERM
  if rollback; then echo 'DEPLOY_RESULT=ROLLED_BACK'; exit "$original_status"; fi
  echo 'Rollback failed'
  echo 'DEPLOY_RESULT=ROLLBACK_FAILED'
  exit 2
}
trap 'handle_failure $?' ERR
trap 'handle_failure 130' HUP INT TERM

compose_candidate pull "$service"
candidate_image_id=$(docker image inspect --format '{{.Id}}' "$image")
[[ $candidate_image_id =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Candidate image ID unavailable'; false; }
cp "$stage/compose.yml" compose.yml
cp "$stage/.env.prod" .env.prod
IMAGE_REF="$image" docker compose --project-directory "$dir" --env-file .env.prod -f compose.yml up -d --pull never --no-deps "$service"
health "$candidate_image_id"
rm -f .deploy-marker
trap - ERR HUP INT TERM
printf '%s\n' 'Deployment health verified'
printf '%s\n' 'DEPLOY_RESULT=SUCCESS'
