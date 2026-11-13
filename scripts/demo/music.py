# Puts a music bed under a narrated video (from mix.py): quiet, ducked further while the voice
# speaks, faded in and out with the video.
# Usage: python3 music.py <video in> <music.mp3> <video out>   (MUSIC_DB: bed level, default -21)
import json, os, subprocess, sys

src, music, out = sys.argv[1:4]
db = float(os.environ.get("MUSIC_DB", "-21"))
dur = float(json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", src],
                                      capture_output=True, check=True).stdout)["format"]["duration"])
f = [
    "[0:a]asplit=2[voice][key]",
    f"[1:a]atrim=0:{dur:.3f},asetpts=PTS-STARTPTS,volume={db}dB,afade=t=in:d=1.5,afade=t=out:st={dur - 3:.3f}:d=3[bed]",
    # duck the bed by a few more dB whenever the narration is speaking
    "[bed][key]sidechaincompress=threshold=0.03:ratio=4:attack=60:release=600:makeup=1[ducked]",
    f"[voice][ducked]amix=inputs=2:normalize=0,atrim=0:{dur:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[a]",
]
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-i", music, "-filter_complex", ";".join(f), "-map", "0:v", "-map", "[a]",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out], check=True)
print(f"{out}: music at {db} dB under the voice")
