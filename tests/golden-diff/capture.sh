#!/usr/bin/env bash
# capture.sh — golden 捕获入口(WSL)。
# 用法: tests/golden-diff/capture.sh <card.png> [--out dir] [--turn "文本"]
# 自备 Playwright 缺的 5 个系统库(nss/nspr/alsa,dpkg -x 免 root)。
set -e
LIBDIR="${PW_LIBDIR:-$HOME/.cache/uberge-pw-libs}"
NEED="libnss3.so libnspr4.so libasound.so.2"
missing=0
for so in $NEED; do [ -f "$LIBDIR/usr/lib/x86_64-linux-gnu/$so" ] || missing=1; done
if [ "$missing" = 1 ]; then
    mkdir -p "$LIBDIR" /tmp/uberge-pw-debs && cd /tmp/uberge-pw-debs
    MIRROR="${APT_MIRROR:-http://mirrors.aliyun.com/ubuntu}/pool/main"
    curl -sfO --noproxy '*' "$MIRROR/n/nspr/libnspr4_4.35-1.1build1_amd64.deb"
    curl -sfO --noproxy '*' "$MIRROR/n/nss/libnss3_3.98-1build1_amd64.deb"
    curl -sfO --noproxy '*' "$MIRROR/a/alsa-lib/libasound2t64_1.2.11-1build2_amd64.deb"
    dpkg -x libnspr4_4.35-1.1build1_amd64.deb "$LIBDIR"
    dpkg -x libnss3_3.98-1build1_amd64.deb "$LIBDIR"
    dpkg -x libasound2t64_1.2.11-1build2_amd64.deb "$LIBDIR"
    cd - >/dev/null
fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export LD_LIBRARY_PATH="$LIBDIR/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec node "$ROOT/tests/golden-diff/capture-golden.mjs" "$@"
