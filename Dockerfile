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
# 6. Install pi-coding-agent globally
# -------------------------------------------------------------------
RUN npm install -g @mariozechner/pi-coding-agent

# -------------------------------------------------------------------
# 7. Run as agent by default, entrypoint is `pi`
# -------------------------------------------------------------------
USER agent
WORKDIR /home/agent

CMD ["pi"]