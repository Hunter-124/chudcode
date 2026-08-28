#!/usr/bin/env bash
# GPU-accelerated variant of the seat: a headless wlroots compositor (cage) for
# GPU rendering, hosting a *rootful* Xwayland so that Chudcode's X11 backend still
# sees a readable root window, real XTEST input and EWMH windows.
#
#   ./seat-gpu.sh start <name>   ./seat-gpu.sh stop <name>
set -euo pipefail

SEAT_ROOT="${CHUDCODE_SEAT_ROOT:-${XDG_RUNTIME_DIR:-/tmp}/chudcode-seats}"
GEOMETRY="${CHUDCODE_SEAT_GEOMETRY:-1920x1080}"
HERE="$(dirname "$(readlink -f "$0")")"

die() { printf 'seat-gpu: %s\n' "$1" >&2; exit 1; }

pick_display() {
	local n
	for n in $(seq 120 149); do
		[[ -e "/tmp/.X${n}-lock" || -e "/tmp/.X11-unix/X${n}" ]] && continue
		printf '%s' "$n"
		return 0
	done
	die "no free display number in :120-:149"
}

cmd_start() {
	local name="${1:?name}" dir num
	dir="$SEAT_ROOT/$name"
	mkdir -p "$dir"
	num="$(pick_display)"
	printf ':%s' "$num" >"$dir/display"

	# MEASURED: this rootful Xwayland hangs x11rb's connection handshake whenever
	# X authentication is in play (server `-auth`, or a client with XAUTHORITY
	# set), and one wedged client blocks further connects. Xvfb does not. So the
	# seat runs with no X auth at all and clients MUST have XAUTHORITY unset.
	cat >"$dir/inner.sh" <<-INNER
		#!/usr/bin/env bash
		# Runs *inside* the headless compositor.
		exec Xwayland -geometry $GEOMETRY -decorate :$num
	INNER
	chmod +x "$dir/inner.sh"

	WLR_BACKENDS=headless \
		WLR_LIBINPUT_NO_DEVICES=1 \
		WLR_HEADLESS_OUTPUTS=1 \
		WLR_RENDERER="${WLR_RENDERER:-gles2}" \
		setsid cage -- "$dir/inner.sh" >"$dir/cage.log" 2>&1 &
	printf '%s' "$!" >"$dir/pid"

	local waited=0
	until [[ -e "/tmp/.X11-unix/X${num}" ]]; do
		sleep 0.1
		waited=$((waited + 1))
		[[ $waited -gt 150 ]] && { tail -20 "$dir/cage.log" >&2; die "Xwayland :$num never appeared"; }
	done

	# The socket existing is not readiness: Chudcode needs the root window to be a
	# readable drawable. Probing it here removes a startup race in which Chudcode's
	# capabilities getter silently reports backend "unavailable"
	# (crates/chud-natives/src/desktop/mod.rs:742 swallows the error).
	waited=0
	until DISPLAY=":$num" env -u XAUTHORITY import -window root -crop 1x1+0+0 png:- >/dev/null 2>&1; do
		sleep 0.1
		waited=$((waited + 1))
		[[ $waited -gt 150 ]] && die "root window on :$num never became readable"
	done

	if [[ -x "$HERE/chudcode-seat-shim" ]]; then
		env -u XAUTHORITY DISPLAY=":$num" setsid "$HERE/chudcode-seat-shim" >"$dir/shim.log" 2>&1 &
		printf '%s' "$!" >"$dir/shim.pid"
	fi

	cat <<-EOF
		CHUDCODE_SEAT_NAME=$name
		CHUDCODE_SEAT_DIR=$dir
		DISPLAY=:$num
		UNSET=XAUTHORITY
		UNSET=WAYLAND_DISPLAY
	EOF
}

cmd_stop() {
	local dir="$SEAT_ROOT/${1:?name}"
	[[ -f "$dir/pid" ]] || die "no such seat"
	[[ -f "$dir/shim.pid" ]] && { kill -TERM "-$(cat "$dir/shim.pid")" 2>/dev/null || true; }
	kill -TERM "-$(cat "$dir/pid")" 2>/dev/null || kill -TERM "$(cat "$dir/pid")" 2>/dev/null || true
	sleep 1
	kill -KILL "-$(cat "$dir/pid")" 2>/dev/null || true
	if [[ -f "$dir/display" ]]; then
		num="$(cat "$dir/display")"
		num="${num#:}"
		pkill -f "Xwayland -geometry .*:${num}\$" 2>/dev/null || true
		rm -f "/tmp/.X${num}-lock" "/tmp/.X11-unix/X${num}"
	fi
	rm -rf "$dir"
	printf 'seat-gpu: stopped %s\n' "$1"
}

case "${1:-}" in
	start) shift; cmd_start "${1:-}" ;;
	stop) shift; cmd_stop "${1:-}" ;;
	*) die "usage: seat-gpu.sh {start|stop} <name>" ;;
esac
