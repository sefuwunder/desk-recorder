#!/bin/sh
# desk-recorder: set up offline transcription (whisper.cpp + model).
# Idempotent — safe to re-run. Everything lands under data/ (gitignored).
# Env overrides: WHISPER_MODEL (default ggml-base.en.bin), WHISPER_VERSION (default v1.9.4).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDIR="$ROOT/data/whisper"
MODEL="${WHISPER_MODEL:-ggml-base.en.bin}"
VERSION="${WHISPER_VERSION:-v1.9.4}"
BIN="$WDIR/whisper-cli"

mkdir -p "$WDIR"

# ---------- 1. whisper-cli binary ----------
if [ -x "$BIN" ]; then
  echo "binary present: $BIN"
else
  ARCH="$(uname -m)"
  OS="$(uname -s)"
  GOT_BIN=""
  if [ "$OS" = "Linux" ]; then
    case "$ARCH" in
      x86_64)  TAG="x64" ;;
      aarch64) TAG="aarch64" ;;
      *)       TAG="" ;;
    esac
    if [ -n "$TAG" ]; then
      # Try prebuilt release assets (naming varies across releases; best effort).
      for ASSET in \
        "whisper-${VERSION}-bin-ubuntu-${TAG}.tar.gz" \
        "whisper-bin-ubuntu-${TAG}.tar.gz" \
        "whisper-${TAG}-linux.tar.gz" \
      ; do
        URL="https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/${ASSET}"
        echo "trying prebuilt: $ASSET"
        if curl -fSL --max-time 120 -o "$WDIR/$ASSET" "$URL" 2>/dev/null; then
          echo "downloaded $ASSET"
          tar -xzf "$WDIR/$ASSET" -C "$WDIR"
          rm -f "$WDIR/$ASSET"
          # normalize: whatever the archive calls it, install as whisper-cli
          FOUND="$(find "$WDIR" -maxdepth 3 -type f \( -name 'whisper-cli' -o -name 'main' \) | head -1 || true)"
          if [ -n "$FOUND" ]; then
            cp "$FOUND" "$BIN"
            chmod +x "$BIN"
            GOT_BIN="yes"
          fi
          break
        fi
      done
    fi
  fi
  if [ -z "$GOT_BIN" ]; then
    if command -v cmake >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1; then
      echo "no prebuilt binary — building whisper.cpp from source (this takes a few minutes)"
      SRC="$WDIR/src"
      if [ ! -d "$SRC/.git" ]; then
        git clone --depth 1 "https://github.com/ggml-org/whisper.cpp" "$SRC"
      else
        git -C "$SRC" fetch --depth 1 origin tag "$VERSION" 2>/dev/null || true
        git -C "$SRC" checkout "$VERSION" 2>/dev/null || true
      fi
      # NOTE: whisper-cli is an "examples" target — keep examples enabled.
      cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release \
        -DWHISPER_BUILD_TESTS=OFF >/dev/null
      cmake --build "$SRC/build" --target whisper-cli -j"$(nproc 2>/dev/null || echo 4)"
      cp "$SRC/build/bin/whisper-cli" "$BIN"
      chmod +x "$BIN"
      echo "built: $BIN"
    else
      echo "ERROR: no prebuilt binary matched and cmake+g++ are missing." >&2
      echo "Install cmake and g++, or set WHISPER_BIN to a whisper.cpp binary." >&2
      exit 1
    fi
  fi
fi

# ---------- 2. model ----------
if [ -f "$WDIR/$MODEL" ]; then
  echo "model present: $WDIR/$MODEL"
else
  echo "downloading model $MODEL (~500MB for base.en)…"
  curl -fSL --max-time 1200 \
    -o "$WDIR/$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
  echo "model saved: $WDIR/$MODEL"
fi

echo "OK — offline transcription ready."
echo "Binary: $BIN"
echo "Model:  $WDIR/$MODEL"
