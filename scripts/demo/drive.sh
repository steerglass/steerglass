#!/bin/sh
# Helpers to drive the demo app (sourced by record.sh). Every action first checks that the demo
# Steerglass is the frontmost app, and stops otherwise: keys never go to another window.
PID=$(pgrep -f "bundle/macos/Steerglass.app/Contents/MacOS/steerglass" | head -1)
[ -n "$PID" ] || { echo "demo app not running" >&2; exit 1; }
WX=36; WY=40; WW=1440; WH=830   # window frame, in points

sg_front() {
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $PID) to true" >/dev/null
  sleep 0.3
  front=$(osascript -e 'tell application "System Events" to unix id of first process whose frontmost is true')
  [ "$front" = "$PID" ] || { echo "Steerglass is not frontmost (pid $front): stopping" >&2; exit 2; }
}
sg_place() {
  sg_front
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $PID) to set position of window 1 to {$WX, $WY}" \
            -e "tell application \"System Events\" to tell (first process whose unix id is $PID) to set size of window 1 to {$WW, $WH}" >/dev/null
}
# sg_keys "text" — types text; sg_key code [modifiers] — e.g. sg_key 36 (return), sg_key 40 command (cmd-K)
sg_type() { sg_front; osascript -e "tell application \"System Events\" to keystroke \"$1\"" >/dev/null; }
sg_slowtype() { s=$1; while [ -n "$s" ]; do c=${s%"${s#?}"}; s=${s#?}; sg_type_raw "$c"; sleep 0.07; done; }
sg_type_raw() { osascript -e "tell application \"System Events\" to keystroke \"$1\"" >/dev/null; }
sg_key() {
  sg_front
  if [ -n "${2:-}" ]; then osascript -e "tell application \"System Events\" to key code $1 using {$2 down}" >/dev/null
  else osascript -e "tell application \"System Events\" to key code $1" >/dev/null; fi
}
sg_char() { # character with modifier: sg_char k command
  sg_front; osascript -e "tell application \"System Events\" to keystroke \"$1\" using {$2 down}" >/dev/null
}
# sg_click x y [command] — window-relative point
sg_click() {
  sg_front
  x=$((WX + $1)); y=$((WY + $2))
  if [ -n "${3:-}" ]; then cliclick -e 120 "kd:$3" "m:$x,$y" "c:$x,$y" "ku:$3"
  else cliclick -e 120 "m:$x,$y" "c:$x,$y"; fi
}
# sg_move x y — glide the pointer to a window-relative point (visible in the video)
sg_move() { cliclick -e 250 "m:$((WX + $1)),$((WY + $2))"; }
sg_shot() { sg_front; screencapture -x -R "$WX,$WY,$WW,$WH" "$1"; }
