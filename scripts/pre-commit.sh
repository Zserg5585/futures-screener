#!/bin/bash
# Pre-commit hook — runs tests before allowing commit
# Install: cp scripts/pre-commit.sh .git/hooks/pre-commit

set -eo pipefail

echo "[pre-commit] Running tests..."
npm test --silent 2>&1

if [ $? -ne 0 ]; then
  echo ""
  echo "[pre-commit] FAILED: Tests did not pass. Commit aborted."
  echo "  Run 'npm test' to see details."
  exit 1
fi

echo "[pre-commit] All tests passed."
