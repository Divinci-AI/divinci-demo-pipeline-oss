# The orchestrator as a container: one invocation = one loop tick.
#
# SHARED by targets/gcp (Cloud Run Job) and targets/aws (ECS Fargate). One image
# definition rather than two, for the same reason targets/local imports the
# Cloudflare chunker instead of copying it: two copies drift, and the drift is
# invisible until one platform behaves differently from the other.
#
# Build from the REPO ROOT so the whole orchestrator is in context:
#   docker build -f targets/container/Dockerfile -t <tag> .
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
COPY targets/container/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The volume mounts at /app/state; entrypoint.sh symlinks /app/runs to it and
# puts the CLI's HOME there too. Created here so the mount has somewhere to land
# and `entrypoint.sh` can tell a missing mount from an empty one.
RUN mkdir -p /app/state

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
