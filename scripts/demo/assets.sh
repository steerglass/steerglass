#!/bin/sh
# Renders the stills of the demo video with headless Chrome: background, window mask, intro and
# outro cards and one caption per scene, for the widescreen (1920x1080) and square (1080x1080) cuts.
# Usage: assets.sh <video dir>  (writes <video dir>/assets)
set -eu
V=${1:?usage: assets.sh <video dir>}
LOGO=$(cd "$(dirname "$0")/../.." && pwd)/website/logo.svg
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
A="$V/assets"
mkdir -p "$A"
cd "$A"

# Captions, one per scene (edit.py numbers them from 1). <b> is the gradient part.
CAPS='All your clusters at a glance — <b>and what needs attention</b>
Pods from five clusters, <b>live in one table</b>
Find what’s broken <b>across all of them</b>
Logs in <b>one keystroke</b>, streaming live
Live <b>CPU and memory</b>, per pod
A <b>shell</b> in any container
No shell inside? <b>Steerglass brings one</b>
A root shell <b>on the node itself</b>
Configs you can read — <b>down to the certificate</b>
Production asks <b>before every change</b>
<b>Port-forward</b> with one click'

shot() { # file width height [transparent]
  if [ -n "${4:-}" ]; then bgc="--default-background-color=00000000"; else bgc=""; fi
  "$C" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=1 $bgc \
    --window-size="$2,$3" --screenshot="$A/$1.png" "file://$A/$1.html" 2>/dev/null
}

for L in wide sq; do
  if [ $L = wide ]; then W=1920; S=""; CAPH=151; WIN="left:180px;top:30px;width:1560px;height:899px;border-radius:18px"
    H1=96; SUB=34; BRAND=46; LOGOW=76; CAPF=40; CAPP=""; BR=" "
  else W=1080; S="_sq"; CAPH=230; WIN="left:20px;top:230px;width:1040px;height:599px;border-radius:14px"
    H1=74; SUB=32; BRAND=42; LOGOW=68; CAPF=48; CAPP="padding:0 60px;"; BR="<br>"
  fi
  cat > base.css <<EOF
html,body{margin:0;width:${W}px;height:1080px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;color:#e6e9f0}
.bg{position:absolute;inset:0;background:#0b0e15}
.glow{position:absolute;inset:0;background:radial-gradient(900px 520px at 85% 0%,rgba(99,102,241,.30),transparent 60%),radial-gradient(800px 500px at 0% 100%,rgba(45,212,191,.20),transparent 60%)}
.alarm{position:absolute;inset:0;background:radial-gradient(1000px 600px at 50% 110%,rgba(239,68,68,.22),transparent 65%),radial-gradient(700px 400px at 50% -10%,rgba(239,68,68,.10),transparent 60%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);background-size:60px 60px}
.g{background:linear-gradient(110deg,#2dd4bf,#6366f1);-webkit-background-clip:text;color:transparent}
.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 60px}
.brand{display:flex;align-items:center;gap:20px;font-size:${BRAND}px;font-weight:700;letter-spacing:-.01em}
h1{font-size:${H1}px;line-height:1.05;letter-spacing:-.035em;margin:48px 0 0;font-weight:800}
.sub{margin-top:30px;font-size:${SUB}px;color:#aab2c5;line-height:1.35}
.url{margin-top:44px;font-size:36px;font-weight:650;padding:16px 34px;border-radius:999px;border:1px solid rgba(45,212,191,.45);color:#5eead4;background:rgba(45,212,191,.08)}
.clock{font-size:${SUB}px;font-weight:600;letter-spacing:.2em;color:#f87171;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:14px}
.clock i{width:14px;height:14px;border-radius:50%;background:#ef4444;box-shadow:0 0 18px #ef4444}
.red{color:#f87171}
EOF
  brand="<div class=\"brand\"><img src=\"file://$LOGO\" width=\"$LOGOW\" height=\"$LOGOW\">Steerglass</div>"
  # background with the window's shadow (square: the brand above the window)
  extra=""; [ $L = sq ] && extra="<div style=\"position:absolute;left:0;right:0;top:78px;display:flex;justify-content:center\">$brand</div>"
  cat > bg$S.html <<EOF
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="base.css"></head><body>
<div class="bg"></div><div class="glow"></div><div class="grid"></div>$extra
<div style="position:absolute;$WIN;box-shadow:0 30px 80px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,.06)"></div></body></html>
EOF
  cat > intro$S.html <<EOF
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="base.css"></head><body>
<div class="bg"></div><div class="alarm"></div><div class="grid"></div><div class="c">
<div class="clock"><i></i>02:07 AM</div>
<h1>Production just broke.<br><span class="red">You need answers. Now.</span></h1></div></body></html>
EOF
  cat > outro$S.html <<EOF
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="base.css"></head><body>
<div class="bg"></div><div class="glow"></div><div class="grid"></div><div class="c">$brand
<h1>Calm, when everything<br><span class="g">else isn’t.</span></h1>
<div class="sub">Free and open source —${BR}no account needed</div><div class="url">steerglass.com</div></div></body></html>
EOF
  for f in bg$S intro$S outro$S; do shot $f $W 1080; done
  n=0
  echo "$CAPS" | while IFS= read -r cap; do
    n=$((n + 1)); f=cap$(echo $S | tr -d _)_$n
    [ $L = sq ] && cap=$(printf '%s' "$cap" | sed 's/ <b>/<br><b>/; s/ — /<br>/')
    cat > $f.html <<EOF
<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${W}px;height:${CAPH}px;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
.c{height:${CAPH}px;display:flex;align-items:center;justify-content:center;text-align:center;$CAPP}
.p{font-size:${CAPF}px;font-weight:650;color:#e6e9f0;letter-spacing:-.01em;line-height:1.2}
.p b{background:linear-gradient(110deg,#2dd4bf,#6366f1);-webkit-background-clip:text;color:transparent}
</style></head><body><div class="c"><div class="p">$cap</div></div></body></html>
EOF
    shot $f $W $CAPH transparent
  done
done
magick -size 1560x899 xc:black -fill white -draw "roundrectangle 0,0 1559,898 18,18" mask.png
magick -size 1040x599 xc:black -fill white -draw "roundrectangle 0,0 1039,598 14,14" mask_sq.png
ls "$A"/*.png | wc -l | xargs echo "stills:"
