FROM debian:trixie-slim

# Avoid interactive prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# -------------------------------------------------------------------
# 1. Base packages + sudo (needed for passwordless sudo later)
# -------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        build-essential \
        sudo \
        curl \
        ca-certificates \
        libssl-dev \
        zlib1g-dev \
        libbz2-dev \
        libreadline-dev \
        libsqlite3-dev \
        libncursesw5-dev \
        xz-utils \
        tk-dev \
        libxml2-dev \
        libxmlsec1-dev \
        libffi-dev \
        liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

# -------------------------------------------------------------------
# 2. pyenv + Python 3.13 (set as default)
# -------------------------------------------------------------------
ENV PYENV_ROOT=/opt/pyenv
ENV PATH="${PYENV_ROOT}/shims:${PYENV_ROOT}/bin:${PATH}"

RUN git clone https://github.com/pyenv/pyenv.git "${PYENV_ROOT}" \
    && pyenv install 3.13 \
    && pyenv global 3.13

# -------------------------------------------------------------------
# 3. Node.js (modern) from NodeSource
# -------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# -------------------------------------------------------------------
# 4. Create group `agent` (GID 1000) and user `agent` (UID 1026)
# -------------------------------------------------------------------
RUN groupadd --gid 1000 agent \
    && useradd \
        --uid 1026 \
        --gid agent \
        --create-home \
        --shell /bin/bash \
        agent

# -------------------------------------------------------------------
# 5. Passwordless sudo for agent
# -------------------------------------------------------------------
RUN echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
    && chmod 440 /etc/sudoers.d/agent

# -------------------------------------------------------------------
# 6. Create .agent-sandbox directory for agent-owned config/state
#     This directory is never overlaid by user mounts, and is always
#     read-write for the agent (even in a read-only sandbox).
# -------------------------------------------------------------------
RUN mkdir -p /home/agent/.agent-sandbox \
    && chown agent:agent /home/agent/.agent-sandbox

# -------------------------------------------------------------------
# 7. Configure npm to install global modules into .agent-sandbox
# -------------------------------------------------------------------
ENV NPM_CONFIG_PREFIX=/home/agent/.agent-sandbox
ENV PATH="/home/agent/.agent-sandbox/bin:${PATH}"

# -------------------------------------------------------------------
# 8. Install pi-coding-agent globally (as agent so files are owned by agent)
# -------------------------------------------------------------------
USER agent
RUN npm install -g @mariozechner/pi-coding-agent pi-ask-user

# Create pi-extensions symlink farm (used by entrypoint to discover packages)
# Adding a new package = add symlink here + update entrypoint script
RUN mkdir -p /home/agent/.agent-sandbox/pi-extensions \
 && ln -s /home/agent/.agent-sandbox/lib/node_modules/pi-ask-user \
         /home/agent/.agent-sandbox/pi-extensions/pi-ask-user

# -------------------------------------------------------------------
# 9. Copy entrypoint script that symlinks pi packages into
#     ~/.pi/agent/extensions/ at startup for auto-discovery.
#     Adding a new package = install above + add to entrypoint script.
# -------------------------------------------------------------------
COPY --chmod=755 entrypoint /home/agent/.agent-sandbox/entrypoint

# -------------------------------------------------------------------
# 10. Run as agent by default, entrypoint sets up extensions then runs pi
# -------------------------------------------------------------------
WORKDIR /home/agent

ENTRYPOINT ["/home/agent/.agent-sandbox/entrypoint"]
CMD ["pi"]
