#!/bin/sh
# desk-recorder: set up offline transcription (whisper.cpp + model).
# Idempotent — safe to re-run. Everything lands under data/ (gitignored).
# Env overrides: WHISPER_MODEL (default ggml-base.en.bin),
#                WHISPER_RELEASE (default b5130 — nightly release with prebuilt binaries),
#                WHISPER_BIN (skip install entirely; src/whisper.ts uses this env directly).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDIR="$ROOT/data/whisper"
MODEL="${WHISPER_MODEL:-ggml-base.en.bin}"
RELEASE="${WHISPER_RELEASE:-b5130}"
# Versioned releases (vX.Y.Z) of whisper.cpp ship no binaries; the nightly
# "bNNNN" releases do. WHISPER_VERSION is kept only for building from source.
VERSION="${WHISPER_VERSION:-v1.9.4}"
BIN="$WDIR/whisper-cli"

mkdir -p "$WDIR"

# ---------- 1. whisper-cli binary ----------
if [ -x "$BIN" ]; then
  echo "binary present: $BIN"
else
  ARCH="$(uname -m)"
  OS="$(uname -s)"
  if [ "$OS" = "Linux" ]; then
    case "$ARCH" in
      x86_64)  ASSET="whisper-bin-ubuntu-x64.tar.gz" ;;
      aarch64) ASSET="whisper-bin-ubuntu-arm64.tar.gz" ;;
      *)       ASSET="" ;;
    esac
  else
    ASSET=""
  fi

  if [ -n "$ASSET" ]; then
    URL="https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/${ASSET}"
    echo "trying prebuilt: $ASSET (release $RELEASE)"
    if curl -fSL --max-time 300 -o "$WDIR/$ASSET" "$URL" 2>/dev/null; then
      echo "downloaded $ASSET"
      PKG="$WDIR/pkg"
      rm -rf "$PKG"
      mkdir -p "$PKG"
      tar -xzf "$WDIR/$ASSET" -C "$PKG"
      rm -f "$WDIR/$ASSET"
      # whisper-cli loads its .so files via $ORIGIN runpath, so it must stay
      # next to its libs — symlink (don't copy) into data/whisper/.
      FOUND="$(find "$PKG" -maxdepth 3 -type f -name 'whisper-cli' | head -1 || true)"
      if [ -n "$FOUND" ]; then
        ln -sf "$FOUND" "$BIN"
        chmod +x "$FOUND"
        echo "installed prebuilt binary: $BIN -> $FOUND"
      else
        echo "WARNING: whisper-cli not found inside $ASSET; falling back to source build" >&2
      fi
    else
      echo "prebuilt download failed (release $RELEASE may be gone); trying source build" >&2
    fi
  fi

  if [ ! -x "$BIN" ]; then
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
      # keep the shared libs beside the binary so it can find them at runtime
      for so in "$SRC/build/bin"/libwhisper.so* "$SRC/build/bin"/libggml*.so*; do
        [ -e "$so" ] && cp "$so" "$WDIR/" || true
      done
      chmod +x "$BIN"
      echo "built: $BIN"
    else
      echo "ERROR: no prebuilt binary could be downloaded and cmake+g++ are missing." >&2
      echo "Fix with one of:" >&2
      echo "  sudo apt install -y cmake g++   # Debian/Ubuntu, then re-run this script" >&2
      echo "  export WHISPER_BIN=/path/to/whisper.cpp/binary   # point at your own build" >&2
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

# sanity: the binary must actually start (resolves its .so files)
if ! "$BIN" --help >/dev/null 2>&1; then
  echo "ERROR: $BIN does not run (missing shared libraries?)." >&2
  echo "Try deleting data/whisper and re-running this script." >&2
  exit 1
fi

echo "OK — offline transcription ready."
echo "Binary: $BIN"
echo "Model:  $WDIR/$MODEL"
