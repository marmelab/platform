#!/bin/bash
# First boot of the platform VM (cloud-init): the prerequisites of docs/INSTALL.md §2, nothing platform-specific.
# Docker Engine with the compose plugin, git, curl, openssl, Node.js 24 with pnpm (the Studio image is built on the
# host), unattended security upgrades. The platform is then installed by hand: INSTALL.md §5.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git openssl unattended-upgrades
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin nodejs
corepack enable
