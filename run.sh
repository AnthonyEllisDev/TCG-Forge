#!/usr/bin/env bash
# TCG Forge launcher for macOS / Linux.
set -e
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Python 3.8+ is required but was not found on your PATH."
  echo "Install it from https://www.python.org/downloads/ and run this script again."
  exit 1
fi

exec "$PY" launch.py "$@"
