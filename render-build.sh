#!/usr/bin/env bash
# Simple build script for Render (no sudo required)
set -o errexit

echo "🔧 Installing Node dependencies..."
npm install

echo "🚀 Installing Chrome for Puppeteer..."
# Set cache directory
export PUPPETEER_CACHE_DIR="$(pwd)/.cache/puppeteer"
echo "📍 Cache directory: $PUPPETEER_CACHE_DIR"

# Install Chrome using Puppeteer's built-in installer
npx puppeteer browsers install chrome

# Verify installation
CHROME_PATH=$(find .cache/puppeteer -name chrome -type f 2>/dev/null | head -1)
if [ -n "$CHROME_PATH" ]; then
    echo "✅ Chrome installed successfully at: $CHROME_PATH"
    chmod +x "$CHROME_PATH" || true
else
    echo "⚠️ Chrome installation verification failed, but continuing..."
fi

echo "✅ Build complete!"
