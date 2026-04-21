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
    # Check that USER directive is present before npm install
    if grep -q "npm install -g" "$SANDBOX_SRC/Dockerfile" && ! grep -qE 'USER (agent|\$\{SANDBOX_USER\})' "$SANDBOX_SRC/Dockerfile"; then
        echo "WARNING: npm install -g found but no USER directive (may install as root)"
    fi
fi

# Check entrypoint is executable (or will be via COPY --chmod=755)
if [[ -f "$SANDBOX_SRC/entrypoint" ]] && [[ ! -x "$SANDBOX_SRC/entrypoint" ]]; then
    if ! grep -q "COPY --chmod=755 entrypoint" "$SANDBOX_SRC/Dockerfile" 2>/dev/null; then
        echo "WARNING: entrypoint is not executable and Dockerfile doesn't set --chmod=755 on COPY"
    fi
fi

# Check sandbox script is executable
if [[ -f "$SANDBOX_SRC/sandbox" ]] && [[ ! -x "$SANDBOX_SRC/sandbox" ]]; then
    echo "WARNING: sandbox script is not executable"
fi

if [[ $errors -eq 0 ]]; then
    echo "✓ All validation checks passed"
    echo ""
    echo "Remember: changes require a Docker image rebuild on the host:"
    echo "  cd $SANDBOX_SRC && ./build"
else
    echo "✗ $errors error(s) found"
    exit 1
fi
