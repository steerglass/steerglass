# Lays the narration (one ElevenLabs take, cut into its sentences) over an edited video: each
# sentence starts with its scene, never before the previous one has ended.
# Usage: python3 mix.py <video dir> <video in> <video out>   (narration in <video dir>/vo/take1.mp3;
#   LAYOUT=square reads timeline_sq.json)
import json, os, subprocess, sys

V, src, out = sys.argv[1:4]
tl = json.load(open(f"{V}/timeline{'_sq' if os.environ.get('LAYOUT') == 'square' else ''}.json"))
# (start, end) of each sentence in the take: intro, the 11 scenes, outro (from whisper word times)
LINES = [(0.00, 5.62), (6.14, 10.42), (10.86, 14.08), (14.48, 16.66), (17.08, 19.76), (20.34, 23.08), (23.60, 25.24),
         (25.72, 28.15), (28.50, 30.56), (30.94, 35.10), (35.58, 39.44), (39.96, 42.90), (43.38, 49.78)]
scenes = [tl["intro"] + 0.5] + [tl[str(n)] + 0.3 for n in range(1, 12)] + [tl["outro"] + 0.4]
starts, prev_end = [], 0.0
for (a, b), s in zip(LINES, scenes):
    st = max(s, prev_end + 0.3)
    starts.append(st)
    prev_end = st + (b - a)
f = [f"[0:a]atrim={max(0, a - 0.05)}:{b + 0.15},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st={b - a + 0.05}:d=0.15,"
     f"adelay={int(st * 1000)}|{int(st * 1000)}[l{i}]" for i, ((a, b), st) in enumerate(zip(LINES, starts))]
f.append("".join(f"[l{i}]" for i in range(len(LINES))) + f"amix=inputs={len(LINES)}:normalize=0,apad,atrim=0:{tl['total']},loudnorm=I=-16:TP=-1.5:LRA=11[a]")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f"{V}/vo/take1.mp3", "-i", f"{V}/{src}", "-filter_complex", ";".join(f),
                "-map", "1:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", f"{V}/{out}"], check=True)
late = [f"{i}:+{st - s:.1f}s" for i, (st, s) in enumerate(zip(starts, scenes)) if st - s > 0.05]
print(f"{out}: voice ends at {prev_end:.1f}s of {tl['total']:.1f}s; lines starting late: {late or 'none'}")
