# Edits a take recorded by record.sh into the demo video: each scene sped up to its length in
# SCENES (its last HOLD seconds play at normal speed, so the result stays on screen), the window
# with rounded corners on the background, one caption per scene, intro and outro cards.
# Usage: python3 edit.py <video dir> <take.mp4>   (stills from assets.sh in <video dir>/assets)
#   LAYOUT=square for 1080x1080, NAME=<output file>. Writes timeline.json for mix.py.
import json, os, subprocess, sys

V, TAKE = sys.argv[1], sys.argv[2]
SQ = os.environ.get("LAYOUT") == "square"
WIN_W, WIN_H, WIN_X, WIN_Y, CAP_Y, SUF, CAP = (1040, 599, 20, 230, 850, "_sq", "capsq_") if SQ else (1560, 899, 180, 30, 929, "", "cap_")
INTRO, OUTRO, FADE, HOLD = 6.6, 8.0, 0.35, 2.0
# scene (as marked by record.sh) -> seconds in the video; captions follow this order
# CUT: seconds dropped from the end of a scene (prod: closing the dialog, so the hold is on it)
SCENES = [("overview", 5.5), ("multicluster", 5.0), ("filter", 4.0), ("logs", 4.2), ("resources", 5.0), ("shell", 4.2),
          ("debug", 5.8), ("node", 5.0), ("config", 6.0), ("prod", 6.0), ("portforward", 5.5)]
CUT = {"prod": 1.7}

marks = {}
for line in open(f"{V}/{TAKE}.scenes"):
    t, name = line.split()
    marks[name] = float(t)
names = [n for n, _ in SCENES] + ["end"]

segs = []  # (start, end, speed, caption)
for i, (name, dur) in enumerate(SCENES):
    a, b = marks[name], marks[names[i + 1]] - 0.2 - CUT.get(name, 0)
    hold = min(HOLD, dur / 2)
    segs.append((a, b - hold, (b - hold - a) / (dur - hold), i + 1))
    segs.append((b - hold, b, 1.0, i + 1))

f, t, caps = [], 0.0, {}
for i, (a, b, sp, cap) in enumerate(segs):
    d = (b - a) / sp
    f.append(f"[0:v]trim={a:.3f}:{b:.3f},setpts=(PTS-STARTPTS)/{sp:.4f},fps=30[s{i}]")
    caps.setdefault(cap, [t, t])[1] = t + d
    t += d
main = t
f.append("".join(f"[s{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=0[raw]")
f.append(f"[raw]scale={WIN_W}:{WIN_H}:flags=lanczos,format=rgba[win]")
f.append(f"[2:v]format=gray,scale={WIN_W}:{WIN_H}[m]")
f.append("[win][m]alphamerge[winr]")
f.append(f"[1:v]loop=-1:1:0,trim=0:{main:.3f},setpts=PTS-STARTPTS,fps=30,format=rgba[bg]")
f.append(f"[bg][winr]overlay={WIN_X}:{WIN_Y}[v0]")
last = "v0"
for n, (c0, c1) in sorted(caps.items()):
    f.append(f"[{2 + n}:v]format=rgba,fade=t=in:st={c0:.3f}:d=0.3:alpha=1[c{n}]")
    f.append(f"[{last}][c{n}]overlay=0:{CAP_Y}:enable='between(t,{c0:.3f},{c1:.3f})'[v{n}]")
    last = f"v{n}"
f.append(f"[{last}]fade=t=in:st=0:d={FADE},fade=t=out:st={main - FADE:.3f}:d={FADE},format=yuv420p[mainv]")
nin = 3 + len(caps)
f.append(f"[{nin}:v]loop=-1:1:0,trim=0:{INTRO},setpts=PTS-STARTPTS,fps=30,fade=t=in:st=0:d=0.8,fade=t=out:st={INTRO - FADE}:d={FADE},format=yuv420p[intro]")
f.append(f"[{nin + 1}:v]loop=-1:1:0,trim=0:{OUTRO},setpts=PTS-STARTPTS,fps=30,fade=t=in:st=0:d={FADE},fade=t=out:st={OUTRO - 0.8}:d=0.8,format=yuv420p[outro]")
f.append("[intro][mainv][outro]concat=n=3:v=1:a=0[out]")
inputs = ["-i", f"{V}/{TAKE}", "-i", f"{V}/assets/bg{SUF}.png", "-i", f"{V}/assets/mask{SUF}.png"]
for n in sorted(caps):
    inputs += ["-loop", "1", "-framerate", "30", "-t", f"{main:.3f}", "-i", f"{V}/assets/{CAP}{n}.png"]
inputs += ["-i", f"{V}/assets/intro{SUF}.png", "-i", f"{V}/assets/outro{SUF}.png"]
out = os.environ.get("NAME", "video-square.mp4" if SQ else "video.mp4")
subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(f), "-map", "[out]",
                "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", f"{V}/{out}"], check=True)
# scene start times in the final video, for the voiceover
json.dump({"intro": 0, **{str(n): INTRO + c0 for n, (c0, _) in caps.items()}, "outro": INTRO + main, "total": INTRO + main + OUTRO},
          open(f"{V}/timeline{SUF}.json", "w"), indent=1)
print(f"{out}: main {main:.1f}s, total {INTRO + main + OUTRO:.1f}s")
