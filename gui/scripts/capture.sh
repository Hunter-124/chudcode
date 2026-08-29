#!/usr/bin/env bash
# Headless screenshot harness for the native chudcode-gui window.
#
# Boots a real desktop server (no client window), then drives `chudcode-gui
# --screenshot` under an X display at several geometries so the ImGui layout can
# be inspected for real. Every run is frame-bounded, so nothing can hang.
#
#   gui/scripts/capture.sh [outdir]
#
# Environment:
#   CHUDCODE_GUI_BIN  gui binary (default: <repo>/gui/build/chudcode-gui)
#   DISPLAY           X display to render on (default: :1)
#   PROJECT_DIR       workspace the server + gui open (default: repo root)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTDIR="${1:-$REPO/gui/build/shots}"
GUI_BIN="${CHUDCODE_GUI_BIN:-$REPO/gui/build/chudcode-gui}"
PROJECT_DIR="${PROJECT_DIR:-$REPO}"
export DISPLAY="${DISPLAY:-:1}"

# Force every chudcode-gui run onto the X display. Unsetting WAYLAND_DISPLAY is
# NOT sufficient: wl_display_connect(NULL) falls back to
# $XDG_RUNTIME_DIR/wayland-0, so GLFW still attaches to the real compositor and
# opens a window on the user's actual desktop. Point XDG_RUNTIME_DIR at a
# socket-free directory so GLFW falls through to X11.
unset WAYLAND_DISPLAY
XDG_RUNTIME_DIR="$(mktemp -d -t chudcode-nowayland.XXXXXX)"
chmod 700 "$XDG_RUNTIME_DIR"
export XDG_RUNTIME_DIR

[ -x "$GUI_BIN" ] || { printf 'capture: gui binary not executable: %s\n' "$GUI_BIN" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { printf 'capture: bun is required\n' >&2; exit 1; }

mkdir -p "$OUTDIR"
SERVER_LOG="$(mktemp -t chudcode-capture-server.XXXXXX)"
SERVER_PID=""

cleanup() {
	[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
	[ -n "$SERVER_PID" ] && wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# 1. Boot the desktop server headlessly and wait for its presence line.
cd "$REPO"
bun "$REPO/gui/scripts/headless-desktop.ts" "$PROJECT_DIR" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

PRESENCE=""
for _ in $(seq 1 120); do
	PRESENCE="$(sed -n 's/^\({"url".*}\)$/\1/p' "$SERVER_LOG" | head -n 1)"
	[ -n "$PRESENCE" ] && break
	kill -0 "$SERVER_PID" 2>/dev/null || break
	sleep 0.25
done

if [ -z "$PRESENCE" ]; then
	printf 'capture: desktop server never reported a URL. Log:\n' >&2
	cat "$SERVER_LOG" >&2
	exit 1
fi

WS_URL="$(printf '%s' "$PRESENCE" | sed -n 's/.*"wsUrl":"\([^"]*\)".*/\1/p')"
TOKEN="$(printf '%s' "$PRESENCE" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
printf 'capture: server ready at %s\n' "$WS_URL"

# 2. Drive the GUI. shot <name> <width> <height> <frames> [extra args...]
shot() {
	local name="$1" width="$2" height="$3" frames="$4"
	shift 4
	local out="$OUTDIR/$name.png"
	rm -f "$out"
	printf 'capture: %s (%sx%s, %s frames)\n' "$name" "$width" "$height" "$frames"
	if ! timeout 60 "$GUI_BIN" \
		--url "$WS_URL" --token "$TOKEN" \
		--screenshot "$out" --width "$width" --height "$height" --frames "$frames" \
		"$@" >"$OUTDIR/$name.log" 2>&1; then
		printf 'capture: %s exited nonzero\n' "$name" >&2
		cat "$OUTDIR/$name.log" >&2
	fi
	if [ -s "$out" ]; then
		printf 'capture:   -> %s (%s bytes)\n' "$out" "$(stat -c %s "$out")"
	else
		printf 'capture:   -> MISSING %s\n' "$out" >&2
	fi
}

if [ "${PHASES:-shots panels}" != "${PHASES#*shots}" ]; then
	shot default-1440x900   1440 900  600 --project "$PROJECT_DIR"
	shot wide-1920x1080     1920 1080 600 --project "$PROJECT_DIR"
	shot narrow-900x600      900 600  600 --project "$PROJECT_DIR"
	shot minimum-800x560     800 560  600 --project "$PROJECT_DIR"
	shot noproject-1440x900 1440 900  600
	shot offline-1440x900   1440 900   40 --project "$PROJECT_DIR"
fi

# 3. Activity panels (Source Control / Graph / Sessions / Search) are only
#    reachable by clicking the rail, so drive a live window with xdotool and
#    grab it with ImageMagick `import`.
if [ "${PHASES:-shots panels}" != "${PHASES#*panels}" ] &&
	command -v xdotool >/dev/null 2>&1 && command -v import >/dev/null 2>&1; then
	# Xvfb has no window manager, so GLFW's window carries no WM_NAME and
	# `xdotool search --name` cannot see it. Diff the root window list instead.
	BEFORE="$(xdotool search --maxdepth 2 '.*' 2>/dev/null | sort || true)"
	"$GUI_BIN" --url "$WS_URL" --token "$TOKEN" --width 1440 --height 900 \
		--frames 200000 --project "$PROJECT_DIR" >"$OUTDIR/interactive.log" 2>&1 &
	GUI_PID=$!
	WIN=""
	for _ in $(seq 1 80); do
		for candidate in $(comm -13 <(printf '%s\n' "$BEFORE") \
			<(xdotool search --maxdepth 2 '.*' 2>/dev/null | sort)); do
			if xdotool getwindowgeometry "$candidate" 2>/dev/null | grep -q '1440x900'; then
				WIN="$candidate"
				break
			fi
		done
		[ -n "$WIN" ] && break
		kill -0 "$GUI_PID" 2>/dev/null || break
		sleep 0.25
	done
	if [ -z "$WIN" ]; then
		printf 'capture: no live window for pid %s\n' "$GUI_PID" >&2
		cat "$OUTDIR/interactive.log" >&2
	else
		printf 'capture: live window %s\n' "$WIN"
		xdotool windowactivate --sync "$WIN" 2>/dev/null || true
		sleep 3
		# Activity rail button centres at 1440x900, measured off the rendered
		# window: first button top is the shell header stack, 43px pitch.
		rail() { # rail <name> <y>
			xdotool mousemove --window "$WIN" 90 "$2"
			sleep 0.3
			xdotool click --window "$WIN" 1
			sleep 3
			import -window "$WIN" "$OUTDIR/panel-$1.png"
			printf 'capture:   -> %s (%s bytes)\n' "$OUTDIR/panel-$1.png" \
				"$(stat -c %s "$OUTDIR/panel-$1.png" 2>/dev/null || echo 0)"
		}
		rail search 211
		rail source-control 254
		rail terminal 297
		rail graph 340
		rail sessions 383
		rail explorer 168
	fi
	kill "$GUI_PID" 2>/dev/null || true
	wait "$GUI_PID" 2>/dev/null || true
else
	printf 'capture: xdotool/import missing, skipping activity-panel shots\n' >&2
fi

printf 'capture: done -> %s\n' "$OUTDIR"
