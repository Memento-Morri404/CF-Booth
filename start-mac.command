#!/bin/bash
# Double-click to start Card Fair Booth on a Mac.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Install Node from https://nodejs.org first, then double-click this again."; read -n 1; exit 1; fi
if [ ! -f .env ] || ! grep -q '^BOOTH_PASSWORD=' .env; then
  echo "First run: choose a password for your booth (6+ characters)."
  read -s -p "Password: " P; echo
  echo "BOOTH_PASSWORD=$P" >> .env
fi
node server.js
