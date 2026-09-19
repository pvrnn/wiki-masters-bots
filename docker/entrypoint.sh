#!/bin/sh
set -e

# Run the browser headed inside a virtual display. Headless is the single
# biggest automation tell, and the Playwright image ships Xvfb for this.
# Harmless when WM_HEADLESS=true.
exec xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24" \
  node /app/dist/index.js "$@"
