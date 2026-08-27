#!/usr/bin/env bash
# Isolated per-agent display "seat" on top of Xvfb.
#
#   ./seat.sh start [<seat-name>]   -> allocate a free display, start Xvfb, print env
#   ./seat.sh env   <seat-name>     -> print the env block for an existing seat
#   ./seat.sh stop  <seat-name>     -> kill the seat's whole process group
#   ./seat.sh list                  -> list live seats
#
# Design notes:
#  * Every seat lives in its own directory holding pidfile + display number, so
#    lifecycle is observable from outside the owning process (no orphan hunting).
#  * Xvfb is started in its own process group; `stop` kills the group, which
#    reaps every GUI app launched into the seat in one shot.
#  * `-nolisten tcp` + a per-seat XAUTHORITY keep the display off the network and
#    off other local users' reach.
set -euo pipefail

SEAT_ROOT="${OMP_SEAT_ROOT:-${XDG_RUNTIME_DIR:-/tmp}/omp-seats}"
GEOMETRY="${OMP_SEAT_GEOMETRY:-1920x1080x24}"

die() { printf 'seat: %s\n' "$1" >&2; exit 1; }

seat_dir() { printf '%s/%s' "$SEAT_ROOT" "$1"; }

pick_display() {
	local n
	for n in $(seq 90 119); do
		[[ -e "/tmp/.X${n}-lock" || -e "/tmp/.X11-unix/X${n}" ]] && continue
		printf ':%s' "$n"
		return 0
	done
	die "no free display number in :90-:119"
}

cmd_start() {
	local name="${1:-seat-$$}" dir disp
	dir="$(seat_dir "$name")"
	[[ -f "$dir/pid" ]] && kill -0 "$(cat "$dir/pid")" 2>/dev/null && die "seat '$name' already running"
	mkdir -p "$dir"
	disp="$(pick_display)"

	local auth="$dir/Xauthority"
	: >"$auth"
	if command -v xauth >/dev/null 2>&1; then
		XAUTHORITY="$auth" xauth -q add "$disp" MIT-MAGIC-COOKIE-1 "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" 2>/dev/null || true
	fi

	# setsid: own process group/session -> one kill tears down Xvfb + all clients.
	setsid Xvfb "$disp" \
		-screen 0 "$GEOMETRY" \
		-nolisten tcp \
		-noreset \
		-dpi 96 \
		+extension GLX +extension RANDR +extension RENDER +extension XTEST \
		>"$dir/Xvfb.log" 2>&1 &
	local xvfb_pid=$!

	printf '%s' "$disp" >"$dir/display"
	printf '%s' "$xvfb_pid" >"$dir/pid"

	local waited=0
	until [[ -e "/tmp/.X11-unix/X${disp#:}" ]]; do
		kill -0 "$xvfb_pid" 2>/dev/null || { cat "$dir/Xvfb.log" >&2; die "Xvfb died on $disp"; }
		sleep 0.05
		waited=$((waited + 1))
		[[ $waited -gt 100 ]] && die "Xvfb on $disp never created its socket"
	done

	# Socket existence is not readiness: omp needs a readable root drawable.
	waited=0
	until DISPLAY="$disp" XAUTHORITY="$auth" import -window root -crop 1x1+0+0 png:- >/dev/null 2>&1; do
		sleep 0.05
		waited=$((waited + 1))
		[[ $waited -gt 100 ]] && die "root window on $disp never became readable"
	done

	# omp reads the window list from EWMH root properties only, so a bare Xvfb
	# reports zero windows. The shim (or any EWMH WM) supplies them. Its lifetime
	# is bound to the X server: when Xvfb dies, Xlib's default I/O error handler
	# exits the shim, so it can never outlive its seat.
	local shim="$(dirname "$(readlink -f "$0")")/omp-seat-shim"
	if [[ -x "$shim" ]]; then
		DISPLAY="$disp" XAUTHORITY="$auth" setsid "$shim" >"$dir/shim.log" 2>&1 &
		printf '%s' "$!" >"$dir/shim.pid"
	else
		printf 'seat: warning: %s not built; desktop.windows() will be empty\n' "$shim" >&2
	fi

	cmd_env "$name"
}

cmd_env() {
	local dir disp
	dir="$(seat_dir "$1")"
	[[ -f "$dir/display" ]] || die "no such seat '$1'"
	disp="$(cat "$dir/display")"
	# WAYLAND_DISPLAY must be *unset*, not empty: omp's backend picker tests
	# presence (var_os().is_some()), so an empty value still selects Wayland.
	cat <<-EOF
		OMP_SEAT_NAME=$1
		OMP_SEAT_DIR=$dir
		DISPLAY=$disp
		XAUTHORITY=$dir/Xauthority
		UNSET=WAYLAND_DISPLAY
	EOF
}

cmd_stop() {
	local dir pid
	dir="$(seat_dir "$1")"
	[[ -f "$dir/pid" ]] || die "no such seat '$1'"
	if [[ -f "$dir/shim.pid" ]]; then
		kill -TERM "-$(cat "$dir/shim.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/shim.pid")" 2>/dev/null || true
	fi
	pid="$(cat "$dir/pid")"
	if kill -0 "$pid" 2>/dev/null; then
		kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
		local waited=0
		while kill -0 "$pid" 2>/dev/null; do
			sleep 0.1
			waited=$((waited + 1))
			[[ $waited -gt 30 ]] && { kill -KILL "-$pid" 2>/dev/null || true; break; }
		done
	fi
	# X servers leave /tmp/.X<n>-lock and /tmp/.X11-unix/X<n> behind when killed.
	# Leaving them leaks display numbers: pick_display treats them as occupied.
	if [[ -f "$dir/display" ]]; then
		local num="$(cat "$dir/display")"
		num="${num#:}"
		rm -f "/tmp/.X${num}-lock" "/tmp/.X11-unix/X${num}"
	fi
	rm -rf "$dir"
	printf 'seat: stopped %s\n' "$1"
}

cmd_list() {
	[[ -d "$SEAT_ROOT" ]] || return 0
	local dir name pid
	for dir in "$SEAT_ROOT"/*/; do
		[[ -f "$dir/pid" ]] || continue
		name="$(basename "$dir")"
		pid="$(cat "$dir/pid")"
		if kill -0 "$pid" 2>/dev/null; then
			printf '%s\tdisplay=%s\tpid=%s\tlive\n' "$name" "$(cat "$dir/display")" "$pid"
		else
			printf '%s\tdisplay=%s\tpid=%s\tDEAD\n' "$name" "$(cat "$dir/display")" "$pid"
		fi
	done
}

case "${1:-}" in
	start) shift; cmd_start "${1:-}" ;;
	env) shift; [[ -n "${1:-}" ]] || die "env needs a seat name"; cmd_env "$1" ;;
	stop) shift; [[ -n "${1:-}" ]] || die "stop needs a seat name"; cmd_stop "$1" ;;
	list) cmd_list ;;
	*) die "usage: seat.sh {start [name]|env <name>|stop <name>|list}" ;;
esac
