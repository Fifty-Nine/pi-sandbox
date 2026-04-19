#!/usr/bin/env bash
# Validate the sandbox Dockerfile and entrypoint for common issues.
set -euo pipefail

SANDBOX_SRC="${SANDBOX_SRC:-/home/agent/.sandbox-source}"
errors=0

# Check Dockerfile exists
if [[ ! -f "$SANDBOX_SRC/Dockerfile" ]]; then
    echo "ERROR: Dockerfile not found at $SANDBOX_SRC/Dockerfile"
    errors=$((errors + 1))
fi

# Check sandbox script exists
if [[ ! -f "$SANDBOX_SRC/sandbox" ]]; then
    echo "ERROR: sandbox script not found at $SANDBOX_SRC/sandbox"
    errors=$((errors + 1))
fi

# Check entrypoint exists
if [[ ! -f "$SANDBOX_SRC/entrypoint" ]]; then
    echo "ERROR: entrypoint not found at $SANDBOX_SRC/entrypoint"
    errors=$((errors + 1))
fi

# Check AGENTS.md exists
if [[ ! -f "$SANDBOX_SRC/AGENTS.md" ]]; then
    echo "ERROR: AGENTS.md not found at $SANDBOX_SRC/AGENTS.md"
    errors=$((errors + 1))
fi

# Validate Dockerfile syntax (basic check)
if command -v docker &>/dev/null; then
    if ! docker build --check "$SANDBOX_SRC" 2>/dev/null; then
        # --check not supported by all Docker versions, fall back to dry-run hint
        echo "WARNING: Could not validate Dockerfile with 'docker build --check'"
        echo "  You will need to rebuild on the host to verify."
    fi
else
    echo "NOTE: Docker not available inside container. Cannot validate Dockerfile build."
    echo "  You will need to rebuild on the host to verify."
fi

# Check for common Dockerfile issues
if [[ -f "$SANDBOX_SRC/Dockerfile" ]]; then
    # Check that USER agent is present before npm install
    if grep -q "npm install -g" "$SANDBOX_SRC/Dockerfile" && ! grep -q "USER agent" "$SANDBOX_SRC/Dockerfile"; then
        echo "WARNING: npm install -g found but no USER agent directive (may install as root)"
    fi
fi

# Check entrypoint is executable
if [[ -f "$SANDBOX_SRC/entrypoint" ]] && [[ ! -x "$SANDBOX_SRC/entrypoint" ]]; then
    echo "WARNING: entrypoint is not executable"
fi

# Check sandbox script is executable
if [[ -f "$SANDBOX_SRC/sandbox" ]] && [[ ! -x "$SANDBOX_SRC/sandbox" ]]; then
    echo "WARNING: sandbox script is not executable"
fi

if [[ $errors -eq 0 ]]; then
    echo "✓ All validation checks passed"
    echo ""
    echo "Remember: changes require a Docker image rebuild on the host:"
    echo "  cd $SANDBOX_SRC && docker build -t agent-sandbox ."
else
    echo "✗ $errors error(s) found"
    exit 1
fi