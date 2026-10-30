#!/bin/sh
set -eu
repo=$1
task_root=$(mktemp -d /tmp/react-lock-XXXXXXXX)
trap 'rm -rf "$task_root"' EXIT
old=sha256:$(printf '%064d' 1)
candidate=sha256:$(printf '%064d' 2)
revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
image=example/service@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
OLD=$old CANDIDATE=$candidate REVISION=$revision
export REAL_TIMEOUT OLD CANDIDATE REVISION

setup() {
  task_dir="$task_root/$1"
  mkdir -p "$task_dir/bin" "$task_dir/.candidate-42-1"
  stage="$task_dir/.candidate-42-1"
  printf 'original compose\n' > "$task_dir/prod.yml"
  printf 'OLD=value\n' > "$task_dir/.env.prod"
  printf 'candidate compose\n' > "$stage/compose.yml"
  printf 'NEW=value\n' > "$stage/.env.prod"
  cp "$repo/scripts/deploy-react-remote.sh" "$stage/remote.sh"
  printf '%s\n' "$old" > "$task_dir/state"
  cat > "$task_dir/bin/timeout" <<'EOF'
#!/bin/sh
[ "$1" = '--signal=KILL' ] && [ "$2" = '62s' ] || exit 3
shift 2
exec "$REAL_TIMEOUT" --signal=KILL 2s "$@"
EOF
  cat > "$task_dir/bin/docker" <<'EOF'
#!/bin/sh
if [ "$1" = inspect ]; then
  if [ -e "$FAKE_DIR/hang-inspect" ]; then echo ready > "$FAKE_DIR/hung"; exec sleep 1000; fi
  case "$3" in *'.Image'*) cat "$FAKE_DIR/state";; *'.Config.Env'*) echo "APP_REVISION=$REVISION";; *) echo 'true healthy';; esac
elif [ "$1" = image ]; then
  case "$4" in *'.Id'*) echo "$CANDIDATE";; *'.Labels'*) echo "$REVISION";; *) echo "APP_REVISION=$REVISION";; esac
elif [ "$1" = compose ]; then
  case " $* " in
    *' config --images '*) echo "$IMAGE_REF";;
    *'rollback.override.yml'*' up '*)
      if [ -e "$FAKE_DIR/hang-rollback" ]; then echo ready > "$FAKE_DIR/hung"; exec sleep 1000; fi
      echo "$OLD" > "$FAKE_DIR/state";;
    *' up '*)
      echo "$CANDIDATE" > "$FAKE_DIR/state"
      if [ -e "$FAKE_DIR/hang-activate" ]; then echo ready > "$FAKE_DIR/hung"; exec sleep 1000; fi;;
  esac
fi
EOF
  cat > "$task_dir/bin/probe-sleep" <<'EOF'
#!/bin/sh
if [ "$1" -gt 5 ]; then
  count=0
  while [ "$count" -lt 120 ]; do
    [ -e "$FAKE_DIR/.deploy-marker" ] || { [ "$count" -lt 10 ] || exit 0; }
    [ ! -e "$FAKE_DIR/hang-activate" ] || { [ "$count" -lt 40 ] || exit 0; }
    sleep 0.1
    count=$((count + 1))
  done
else sleep 0.05; fi
EOF
  cat > "$task_dir/bin/probe-curl" <<'EOF'
#!/bin/sh
printf 200
EOF
  chmod +x "$task_dir/bin/timeout" "$task_dir/bin/docker" "$task_dir/bin/probe-sleep" "$task_dir/bin/probe-curl"
  export FAKE_DIR="$task_dir" DEPLOY_SLEEP_BIN="$task_dir/bin/probe-sleep" DEPLOY_CURL_BIN="$task_dir/bin/probe-curl"
  export PATH="$task_dir/bin:$base_path"
}

run_action() {
  bash "$repo/scripts/deploy-react-remote.sh" "$1" "$task_dir" app app-prod "$image" http://127.0.0.1:8080/health 1 42-1 "$stage" prod.yml "$revision" > "$task_dir/$1.log" 2>&1
}
restored() {
  [ ! -e "$task_dir/.deploy-marker" ] && [ "$(cat "$task_dir/state")" = "$old" ] &&
    [ "$(cat "$task_dir/prod.yml")" = 'original compose' ] && [ "$(cat "$task_dir/.env.prod")" = 'OLD=value' ] && [ ! -e "$task_dir/compose.yml" ]
}
base_path=$PATH

setup activate
touch "$task_dir/hang-activate"
if run_action activate; then echo 'activation unexpectedly succeeded'; exit 1; fi
[ -f "$task_dir/hung" ] || { echo 'activation never reached hanging Docker'; exit 1; }
count=0
while [ -e "$task_dir/.deploy-marker" ] && [ "$count" -lt 100 ]; do sleep 0.1; count=$((count + 1)); done
restored || { echo 'watchdog did not restore activation'; exit 1; }
grep -q 'DEPLOY_RESULT=ROLLED_BACK' "$task_dir/.backup-42-1/watchdog.log" || exit 1
echo 'PASS: real flock watchdog recovered after activation Docker hung'

setup finalize
run_action activate || { cat "$task_dir/activate.log"; exit 1; }
touch "$task_dir/hang-inspect"
if run_action finalize; then echo 'finalize unexpectedly succeeded'; exit 1; fi
[ -f "$task_dir/hung" ] && grep -q 'DEPLOY_RESULT=ACTION_TIMEOUT' "$task_dir/finalize.log" || exit 1
rm "$task_dir/hang-inspect"
run_action rollback || { cat "$task_dir/rollback.log"; exit 1; }
restored || { echo 'rollback after finalize timeout did not restore state'; exit 1; }
echo 'PASS: finalize timeout released real flock for rollback'

setup rollback
run_action activate || { cat "$task_dir/activate.log"; exit 1; }
touch "$task_dir/hang-rollback"
set +e
run_action rollback
status=$?
set -e
[ "$status" -eq 2 ] && [ -f "$task_dir/hung" ] && grep -q 'DEPLOY_RESULT=ROLLBACK_FAILED' "$task_dir/rollback.log" && [ -f "$task_dir/.deploy-marker" ] || { echo 'rollback timeout did not fail distinctly'; exit 1; }
rm "$task_dir/hang-rollback"
run_action rollback || { cat "$task_dir/rollback.log"; exit 1; }
restored || { echo 'rollback retry did not restore state'; exit 1; }
echo 'PASS: rollback timeout failed distinctly and released real flock for retry'

setup watchdog
run_action activate || { cat "$task_dir/activate.log"; exit 1; }
touch "$task_dir/hang-activate" "$task_dir/hang-rollback"
count=0
while ! grep -q 'DEPLOY_RESULT=ROLLBACK_FAILED' "$task_dir/.backup-42-1/watchdog.log" && [ "$count" -lt 120 ]; do sleep 0.1; count=$((count + 1)); done
grep -q 'DEPLOY_RESULT=ROLLBACK_FAILED' "$task_dir/.backup-42-1/watchdog.log" && [ -f "$task_dir/.deploy-marker" ] || { echo 'watchdog rollback timeout was not recorded'; exit 1; }
rm "$task_dir/hang-rollback" "$task_dir/hang-activate"
run_action rollback || { cat "$task_dir/rollback.log"; exit 1; }
restored || { echo 'retry after watchdog timeout did not restore state'; exit 1; }
echo 'PASS: watchdog rollback timeout failed distinctly and allowed retry'
