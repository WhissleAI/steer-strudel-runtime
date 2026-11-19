#!/usr/bin/env python3
"""The Android build's one modification of strudel.js (android/app/build.gradle, task copyStrudel): on every line that
holds the palette table entry `deepsea:["#0FA3B1"`, the "steer" palette is inserted in front of it. Gradle's filter
reads and writes the file line by line (lines joined with "\n"); this script does the same.

    python3 android/steer_palette.py Resources/strudel/strudel.js android-strudel.js
"""
import sys
src, dst = sys.argv[1], sys.argv[2]
OLD = 'deepsea:["#0FA3B1"'
NEW = 'steer:["#7FD9C2","#E7A93A","#4FB89E","#ACEDDC","#F1F0F0","#1C9AA2"],deepsea:["#0FA3B1"'
text = open(src, encoding="utf-8").read()
lines = text.split("\n")
out = [l.replace(OLD, NEW) if OLD in l else l for l in lines]
res = "\n".join(out)
if 'steer:["#7FD9C2"' not in res:
    sys.exit("the palette table moved; the steer palette was not added")
open(dst, "w", encoding="utf-8").write(res)
