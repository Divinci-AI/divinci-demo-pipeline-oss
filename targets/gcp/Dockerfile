# The orchestrator as a Cloud Run Job: one invocation = one loop tick.
#
# Node 22 to match `engines` and the version CI tests against. Slim rather than
# alpine because `tsx` and the toolchain want glibc.
FROM node:22-slim

# git: the landing step clones a template repository.
# ca-certificates: every outbound call is https.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The `divinci` CLI is the orchestrator's execution layer — it drives every
# pipeline step. Pinned deliberately: an unpinned CLI means a job that worked
# yesterday can change behaviour overnight with nothing in this repo changing.
ARG DIVINCI_CLI_VERSION=latest
RUN npm install -g "@divinci-ai/cli@${DIVINCI_CLI_VERSION}"

WORKDIR /app

# Dependencies first so a source edit does not re-resolve the tree.
COPY orchestrator/package.json orchestrator/package-lock.json ./orchestrator/
RUN cd orchestrator && npm ci

COPY orchestrator ./orchestrator
COPY policies ./policies
COPY research ./research
COPY targets/gcp/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# `runs/` is the state directory and MUST be the GCS volume mount, not this
# path. It is created so a misconfigured job fails on an empty directory rather
# than on a missing one — and `entrypoint.sh` refuses when the mount is absent.
RUN mkdir -p /app/runs

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
