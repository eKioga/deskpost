# The queued lander's image (PLAN-build-regroup.md point 7; kickoffs/s205 row 4): tools/lander.mts and the
# tools/land.mts it imports, on Node 24. Komodo Build deskpost-lander on the lab's build server builds it;
# Action deskpost-lander-autobuild starts it when LANDER_VERSION rises on master; tags X.Y.Z, X.Y, X and the commit, never latest.
# node:24-bookworm-slim is pinned by the digest of its multi-platform index, read from registry-1.docker.io on
# 2026-11-11. The lander reads its secrets itself over HTTPS at start (kickoffs/s209), so the image carries no other tool.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# The lander speaks HTTPS to its secret store.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY tools/land.mts tools/lander.mts /app/tools/
# The lander runs as the image's non-root node user.
ENV HOME=/home/node LANDER_PORT=8080
USER node
CMD ["node", "tools/lander.mts", "serve"]
