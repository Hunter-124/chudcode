#!/usr/bin/env bash
# One-shot proof: isolated seat -> real GUI app -> Chudcode native capture + input,
# with before/after snapshots of the user's live KDE Wayland session.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

SEAT="${1:-proof}"
# SEAT_KIND=xvfb  -> Xvfb seat (no GPU, zero extra packages)
# SEAT_KIND=gpu   -> headless wlroots (cage) + rootful Xwayland (NVIDIA GPU)
SEAT_KIND="${SEAT_KIND:-xvfb}"
if [[ $SEAT_KIND == gpu ]]; then
	SEAT_MGR=./seat-gpu.sh
	EV_PREFIX=gpu-
else
	SEAT_MGR=./seat.sh
	EV_PREFIX=
fi
EV=evidence
mkdir -p "$EV"

USER_XAUTH="${XAUTHORITY:-$HOME/.Xauthority}"

# Every probe here must speak to the user's session, never the seat, so the seat
# env (exported below) is explicitly stripped per command.
user_state() {
	printf '  pointer(:0):         %s\n' "$(env DISPLAY=:0 XAUTHORITY="$USER_XAUTH" xdotool getmouselocation 2>&1)"
	printf '  kwin currentDesktop: %s\n' "$(gdbus call --session --dest org.kde.KWin --object-path /KWin --method org.kde.KWin.currentDesktop 2>&1)"
	printf '  kwin activeOutput:   %s\n' "$(gdbus call --session --dest org.kde.KWin --object-path /KWin --method org.kde.KWin.activeOutputName 2>&1)"
	printf '  ESTAB conns to user X0: %s\n' "$(ss -x 2>/dev/null | grep -c '@/tmp/\.X11-unix/X0')"
	printf '  clients on user a11y bus (Chudcode wayland backend): %s\n' \
		"$(env -u XAUTHORITY DISPLAY=:0 bun probe.ts 2>/dev/null | grep -c '"app"' || true)"
}

gcc -O2 -Wall -o chudcode-seat-shim ewmh-shim.c -lX11

echo "=== USER SESSION BEFORE ($(date -Is))"
user_state | tee "$EV/${EV_PREFIX}09-user-session-before.txt"

echo
echo "=== SEAT START"
seat_env="$("$SEAT_MGR" start "$SEAT" | tee "$EV/${EV_PREFIX}03-seat-start.txt")"
trap "$SEAT_MGR"' stop '"$SEAT"' || true' EXIT
while IFS= read -r line; do
	case "$line" in
		DISPLAY=* | XAUTHORITY=* | CHUDCODE_SEAT_DIR=*) export "${line?}" ;;
	esac
done <<<"$seat_env"
printf '%s\n' "$seat_env"

echo
echo "=== Chudcode BACKEND ON THE SEAT"
env -u WAYLAND_DISPLAY bun probe.ts | tee "$EV/${EV_PREFIX}04-seat-capabilities.txt"

echo
echo "=== END-TO-END RENDER + INPUT"
set +e
env -u WAYLAND_DISPLAY EV_PREFIX="$EV_PREFIX" bun verify.ts | tee "$EV/${EV_PREFIX}10-verify-run.txt"
status=${PIPESTATUS[0]}
set -e

echo
echo "=== USER SESSION AFTER ($(date -Is))"
user_state | tee "$EV/${EV_PREFIX}12-user-session-after.txt"

echo
echo "=== DIFF OF USER SESSION STATE"
if diff -u "$EV/${EV_PREFIX}09-user-session-before.txt" "$EV/${EV_PREFIX}12-user-session-after.txt" >"$EV/${EV_PREFIX}13-user-session-diff.txt"; then
	echo "IDENTICAL: user session state unchanged"
else
	cat "$EV/${EV_PREFIX}13-user-session-diff.txt"
fi

echo
echo "=== TEARDOWN"
seat_pids="$(pgrep -f "user-data-dir=$CHUDCODE_SEAT_DIR" | tr '\n' ' ')"
echo "seat GUI pids before stop: $seat_pids"
trap - EXIT
./seat.sh stop "$SEAT"
sleep 2
{
	printf 'seat GUI pids after stop:  %s\n' "$(pgrep -f "user-data-dir=$CHUDCODE_SEAT_DIR" | tr '\n' ' ')"
	printf 'chudcode-seat-shim procs:       %s\n' "$(pgrep -x chudcode-seat-shim | tr '\n' ' ')"
	printf 'Xvfb procs:                %s\n' "$(pgrep -x Xvfb | tr '\n' ' ')"
	printf 'X sockets:                 %s\n' "$(ls /tmp/.X11-unix/ | tr '\n' ' ')"
	printf 'seat dirs:                 %s\n' "$(ls "${XDG_RUNTIME_DIR:-/tmp}/chudcode-seats" 2>/dev/null | tr '\n' ' ')"
} | tee "$EV/${EV_PREFIX}14-teardown.txt"

exit $status
