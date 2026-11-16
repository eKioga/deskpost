# The deskpost-ci image (PLAN-build-regroup.md, end state point 2; kickoffs/s200 row 2): what the Linux runner's job
# needs to run the kernel self-test from a fetched head. Node 24, Python 3, git, gitleaks. Built and pushed to
# the Forgejo container registry as kioga/deskpost-ci by its owner, not by a build seat; until then the runner's label uses
# node:24-bookworm and the workflow installs the rest itself.
FROM node:24-bookworm

ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    -o /tmp/gitleaks.tar.gz \
 && printf '%s  /tmp/gitleaks.tar.gz\n' "$GITLEAKS_SHA256" | sha256sum -c - \
 && tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks \
 && rm /tmp/gitleaks.tar.gz \
 && gitleaks version
