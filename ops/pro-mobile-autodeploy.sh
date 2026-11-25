#!/usr/bin/env bash
# Run as admin. Never execute fetched repository code as root.
set -Eeuo pipefail
umask 077
app=/home/admin/pro-mobile-test
state=/home/admin/.local/state/pro-mobile-deploy
bun=/home/admin/.bun/bin/bun
export GIT_SSH_COMMAND='ssh -i /home/admin/.ssh/pro-mobile-github -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15'
files=(app.js forward-review.js package.json paper.js pattern-feed.js patterns.js pro2-engine.js pro2-observer.js pro2-trades.js review.js server.js swing-research.js twenty.js public/app.js public/favicon.svg public/index.html public/style.css)
[[ "$(id -un)" == admin ]] || { echo 'Run as admin, not root'; exit 1; }
mkdir -p "$state"
exec 9>"$state/lock"
flock -n 9 || exit 0
if [[ ! -d "$state/repo/.git" ]]; then
  git clone --no-checkout --branch production git@github.com:2331142708-max/Pro-mobile.git "$state/repo"
fi
git -C "$state/repo" fetch --no-tags origin refs/heads/production
sha=$(git -C "$state/repo" rev-parse FETCH_HEAD)
if [[ "${1:-}" != --init && -f "$state/current" && "$(cat "$state/current")" == "$sha" ]]; then exit 0; fi
stage=$(mktemp -d "$state/stage.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
git -C "$state/repo" archive "$sha" -- "${files[@]}" | tar -xf - -C "$stage"
[[ -d "$app/public" && ! -L "$app/public" && ! -L "$stage/public" ]]
for f in "${files[@]}"; do
  [[ -f "$stage/$f" && ! -L "$stage/$f" && -f "$app/$f" && ! -L "$app/$f" ]] || { echo "Invalid source path: $f"; exit 1; }
done
"$bun" build "$stage/server.js" --target=bun --outfile "$stage/check-server.js" >/dev/null
"$bun" build "$stage/public/app.js" --target=browser --outfile "$stage/check-ui.js" >/dev/null
healthy() {
  systemctl is-active --quiet pro-mobile.service &&
  curl -fsS --max-time 4 http://127.0.0.1:3088/ >/dev/null &&
  curl -fsS --max-time 4 http://127.0.0.1:3088/api/pro2/health >/dev/null
}
if [[ "${1:-}" == --init ]]; then
  for f in "${files[@]}"; do
    cmp -s "$stage/$f" "$app/$f" || { echo "Baseline mismatch: $f"; exit 1; }
  done
  healthy || { echo 'Current site health check failed'; exit 1; }
  printf '%s\n' "$sha" > "$state/current"
  echo "BASELINE OK $sha"
  exit 0
fi
[[ -f "$state/current" ]] || { echo 'Run --init first'; exit 1; }
if [[ -f "$state/rejected" && "$(cat "$state/rejected")" == "$sha" ]]; then exit 0; fi
old=$(cat "$state/current")
git -C "$state/repo" merge-base --is-ancestor "$old" "$sha" || { echo 'Non-fast-forward deployment refused'; exit 1; }
for f in "${files[@]}"; do
  git -C "$state/repo" show "$old:$f" | cmp -s - "$app/$f" || { echo "Local source changed: $f"; exit 1; }
done
backup=$(mktemp -d "$state/backup.XXXXXX")
mkdir -p "$backup/public"
for f in "${files[@]}"; do cp -p -- "$app/$f" "$backup/$f"; done
rollback() {
  trap - ERR
  set +e
  echo "Deployment failed; restoring $backup"
  for f in "${files[@]}"; do cp -p -- "$backup/$f" "$app/$f" || echo "RESTORE ERROR: $f"; done
  sudo -n /usr/bin/systemctl restart pro-mobile.service
  printf '%s\n' "$sha" > "$state/rejected"
  exit 1
}
trap rollback ERR
sudo -n /usr/bin/systemctl stop pro-mobile.service
for f in "${files[@]}"; do cp -p -- "$stage/$f" "$app/$f"; done
sudo -n /usr/bin/systemctl start pro-mobile.service
ok=0
for i in {1..30}; do
  if healthy; then ok=1; break; fi
  sleep 1
done
[[ "$ok" == 1 ]] || rollback
printf '%s\n' "$sha" > "$state/current.tmp"
mv "$state/current.tmp" "$state/current"
trap - ERR
echo "DEPLOY OK $sha; backup $backup"
