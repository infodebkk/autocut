#!/usr/bin/env bash
# ঐচ্ছিক: FFmpeg ফাইল নিজের repo-তে রাখতে চাইলে একবার চালান (আপনার কম্পিউটারে, ইন্টারনেট লাগবে)।
# তারপর vendor/ffmpeg/ ফোল্ডারসহ commit ও push করুন। অ্যাপ প্রথমে এই কপিই ব্যবহার করবে।
set -euo pipefail
cd "$(dirname "$0")/.."
D=vendor/ffmpeg
mkdir -p "$D"
LIB=https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd
CORE=https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd
curl -fL "$LIB/ffmpeg.js"        -o "$D/ffmpeg.js"
curl -fL "$LIB/814.ffmpeg.js"    -o "$D/814.ffmpeg.js"
curl -fL "$CORE/ffmpeg-core.js"  -o "$D/ffmpeg-core.js"
curl -fL "$CORE/ffmpeg-core.wasm" -o "$D/ffmpeg-core.wasm"
ls -lh "$D"
