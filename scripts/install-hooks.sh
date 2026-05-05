#!/bin/bash
# Install git hooks
# Usage: ./scripts/install-hooks.sh

set -euo pipefail

APP_DIR="/home/app/futures-screener"
HOOKS_DIR="$APP_DIR/.git/hooks"

echo "Installing git hooks..."

# Pre-commit hook
cp "$APP_DIR/scripts/pre-commit.sh" "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/pre-commit"
echo "  [OK] pre-commit hook installed"

echo "Done. Hooks will run on next commit."
