# A box starting, as its person, once it's claimed (box/agent.ts passes on the
# VIBES_* settings src/server/boxes.ts gives it): their clone of the sketch,
# on main, made the first time; git set up to reach vibes with the box's
# token; vibes' extension and settings in place; then their VS Code, under the
# path vibes reaches it at.
#
# Its home, /home/workspace, is theirs, kept apart from the box: the clone, VS
# Code's state and anything installed there carry on from one box to the next.

cd /home/workspace

git config --global user.name "$VIBES_USER_NAME"
git config --global user.email "$VIBES_USER_EMAIL"
git config --global init.defaultBranch main
# Everyone's clone is on main: pulling puts their own commits on top of
# everyone else's, rather than merging, so main stays one line.
git config --global pull.rebase true
# The box's token, which git asks for when it talks to vibes, rather than
# keeping it in the clone.
# shellcheck disable=SC2016
git config --global credential.helper '!f() { echo username=box; echo "password=$VIBES_BOX_TOKEN"; }; f'

# Clones used to be at /home/workspace/sketch, before each sketch had a folder
# of its own: moved, with any checkouts of single commits told where it went.
if [ ! -e "$VIBES_FOLDER" ] && [ -d /home/workspace/sketch/.git ]; then
  mkdir -p "$(dirname "$VIBES_FOLDER")"
  mv /home/workspace/sketch "$VIBES_FOLDER"
  git -C "$VIBES_FOLDER" worktree repair >/dev/null 2>&1 || true
fi

if [ ! -d "$VIBES_FOLDER/.git" ]; then
  git clone --quiet "$VIBES_GIT_URL" "$VIBES_FOLDER"
fi
# vibes may be somewhere else since the clone was made.
git -C "$VIBES_FOLDER" remote set-url origin "$VIBES_GIT_URL"

# Clones used to start on a branch of the person's own. One still on another
# branch, with no commits main hasn't got, moves to main's latest, taking any
# changes not yet committed with it; if they'd clash with what's changed on
# main since, git won't, and it stays as it is. One with commits of its own
# is left as it is, as is a clone whose main has commits not pushed yet.
on=$(git -C "$VIBES_FOLDER" symbolic-ref --quiet --short HEAD || true)
if [ -n "$on" ] && [ "$on" != main ] &&
  git -C "$VIBES_FOLDER" fetch --quiet origin main &&
  git -C "$VIBES_FOLDER" merge-base --is-ancestor HEAD origin/main &&
  { ! git -C "$VIBES_FOLDER" rev-parse --verify --quiet refs/heads/main >/dev/null ||
    git -C "$VIBES_FOLDER" merge-base --is-ancestor main origin/main; }; then
  git -C "$VIBES_FOLDER" switch --quiet --force-create main origin/main ||
    echo "left $VIBES_FOLDER on $on: its changes clash with main's" >&2
fi

# vibes' extension, this image's version of it, in place of any older one.
# VS Code only loads the extensions its list names, so it's listed too
# (beside any others the person has installed). Its folder is named for this
# build (its Nix hash): the browser keeps what the preview's webview loads by
# path and ETag, and an ETag is only mtime and size, the mtime always 1970 in
# Nix, so a new build at the same path and size would be taken for the old.
data=/home/workspace/.openvscode-server
mkdir -p "$data/extensions" "$data/data/Machine"
version=$(jq -r .version "$VIBES_EXTENSION/package.json")
build=$(basename "$VIBES_EXTENSION")
here="vibes.vibes-sketch-$version-${build%%-*}"
find "$data/extensions" -maxdepth 1 -name 'vibes.vibes-sketch-*' ! -name "$here" -exec rm -rf {} +
ln -sfn "$VIBES_EXTENSION" "$data/extensions/$here"
list="$data/extensions/extensions.json"
[ -f "$list" ] || echo '[]' >"$list"
# shellcheck disable=SC2016
jq --arg path "$data/extensions/$here" --arg rel "$here" --arg version "$version" '
  [.[] | select(.identifier.id != "vibes.vibes-sketch")] + [{
    identifier: { id: "vibes.vibes-sketch" },
    version: $version,
    location: { "$mid": 1, path: $path, scheme: "file" },
    relativeLocation: $rel,
    metadata: { installedTimestamp: 0, source: "vsix" }
  }]' "$list" >"$list.new"
mv "$list.new" "$list"

# Settings for everyone's box (theme, autosave, git); a person's own are kept in their browser.
install -m 0644 "$VIBES_SETTINGS" "$data/data/Machine/settings.json"

exec openvscode-server \
  --host 0.0.0.0 \
  --port 3000 \
  --connection-token "$VIBES_VSCODE_TOKEN" \
  --server-base-path "$VIBES_BASE_PATH" \
  --default-folder "$VIBES_FOLDER" \
  --disable-workspace-trust \
  --telemetry-level off
