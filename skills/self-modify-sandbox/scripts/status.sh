#!/bin/bash
# Show the current sandbox configuration and environment.
set -e
SANDBOX_SRC="/home/agent/.sandbox-source"

echo "=== Sandbox Self-Modify Status ==="
echo ""

if [[ ! -d "$SANDBOX_SRC" ]]; then
    echo "Sandbox source is NOT mounted."
    echo "Launch with --self-modify to enable self-modification."
    exit 0
fi

echo "Source directory: $SANDBOX_SRC"
echo ""

echo "Files:"
ls -la "$SANDBOX_SRC"
echo ""

echo "Dockerfile packages (step 8):"
grep -E 'npm install -g' "$SANDBOX_SRC/Dockerfile" || echo "  (none found)"
echo ""

echo "Extension symlinks (step 8):"
grep -E 'ln -s' "$SANDBOX_SRC/Dockerfile" || echo "  (none found)"
echo ""

echo "Entrypoint extension symlinks:"
grep -E 'ln -sfn' "$SANDBOX_SRC/entrypoint" || echo "  (none found)"
echo ""

if [[ -d "$SANDBOX_SRC/.git" ]]; then
    echo "Git status:"
    cd "$SANDBOX_SRC"
    git status --short
    echo ""
    echo "Current branch: $(git rev-parse --abbrev-ref HEAD)"
    echo "Last commit: $(git log -1 --oneline)"
else
    echo "Git: not a repository"
fi