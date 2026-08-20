#!/bin/bash
set -e

echo "Setting up SilentScribe..."

# Ensure we are in the extension directory
cd "$(dirname "$0")"

# Install @xenova/transformers
echo "Installing @xenova/transformers..."
npm install @xenova/transformers

# Create the lib directory if it doesn't exist
mkdir -p lib

DIST=node_modules/@xenova/transformers/dist

# Copy the minified transformers.js bundle
echo "Copying transformers.min.js to lib/ ..."
cp "$DIST/transformers.min.js" lib/

# Copy the ONNX Runtime WebAssembly binaries.
#
# Without these the runtime downloads about 10 MB from a CDN on every cold
# start, so transcription needs the network and fails whenever the CDN is
# unreachable. transcription-worker.js points wasmPaths at lib/ instead.
#
# Only the single-threaded builds are copied. The threaded builds spawn a
# worker from a Blob URL, which the Manifest V3 content security policy blocks
# with "Failed to execute 'importScripts' on 'WorkerGlobalScope'", so the
# worker pins ONNX Runtime to one thread and never requests them.
echo "Copying ONNX Runtime WebAssembly binaries to lib/ ..."
cp "$DIST/ort-wasm-simd.wasm" lib/   # used when the CPU supports SIMD
cp "$DIST/ort-wasm.wasm"      lib/   # fallback when it does not

# Generate utils/managed-config.js from .claude/.env, when that file exists.
# It holds the bundled API key and is listed in .gitignore.
if [ -f .claude/.env ]; then
  echo "Generating utils/managed-config.js from .claude/.env ..."
  node scripts/build-config.mjs
else
  echo "No .claude/.env found — skipping managed config."
  echo "  The extension will start with no bundled key; set one in Settings."
fi

echo ""
echo "Setup complete. Load the extension in Chrome with Load unpacked."
