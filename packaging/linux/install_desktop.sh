#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ASSET_DIR="$REPO_ROOT/assets/appicon"
APPLICATION_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

sizes=(16 24 32 48 64 128 256)
for size in "${sizes[@]}"; do
    source_icon="$ASSET_DIR/$size.png"
    if [[ ! -f "$source_icon" ]]; then
        printf 'missing generated icon: %s\n' "$source_icon" >&2
        exit 1
    fi
    install -Dm0644 "$source_icon" \
        "$ICON_ROOT/${size}x${size}/apps/chudcode.png"
done

install -Dm0644 "$SCRIPT_DIR/chudcode.desktop" \
    "$APPLICATION_DIR/chudcode.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPLICATION_DIR"
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache --force --ignore-theme-index "$ICON_ROOT"
fi

printf 'Installed Chudcode desktop integration in %s\n' \
    "${XDG_DATA_HOME:-$HOME/.local/share}"
