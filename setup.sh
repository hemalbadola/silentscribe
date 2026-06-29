#!/bin/bash
set -e

echo "Setting up SilentScribe Transcription Worker..."

# Ensure we are in the extension directory
cd "$(dirname "$0")"

# Install @xenova/transformers
echo "Installing @xenova/transformers..."
npm install @xenova/transformers

# Create the lib directory if it doesn't exist
mkdir -p lib

# Copy the minified transformers.js bundle
echo "Copying transformers.min.js to lib/ directory..."
cp node_modules/@xenova/transformers/dist/transformers.min.js lib/

echo ""
echo "✅ Setup complete! The extension is now ready to be loaded into Chrome."
