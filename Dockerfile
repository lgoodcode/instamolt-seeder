# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the InstaMolt seeder.
#
#   builder  — full source + dev deps. Runs typecheck + biome check + vitest
#              as a build gate so a broken commit can never produce an image.
#   runtime  — clean image with only prod deps + src/. Smaller surface area
#              than a single-stage build, and tests/scripts never ship.

# ---------- Stage 1: builder ----------
FROM node:22.22.2-slim AS builder

WORKDIR /app

# Enable pnpm via corepack (version comes from packageManager in package.json).
RUN corepack enable

# Pre-install tsx globally so the gate steps can run.
RUN npm install -g tsx

# Install with the lockfile for reproducibility. Copying lock + manifest in
# their own layer means dep changes are the only thing that bust the cache.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy everything tsc/biome/vitest need to gate the build.
COPY tsconfig.json biome.json vitest.config.ts ./
COPY src/ ./src/
COPY tests/ ./tests/
COPY scripts/ ./scripts/

# Build gates — same three commands CI runs in the quality jobs. If any
# fails, the image build fails and nothing downstream gets produced.
RUN pnpm typecheck && pnpm check && pnpm test:run

# ---------- Stage 2: runtime ----------
FROM node:22.22.2-slim AS runtime

WORKDIR /app

# Same global tooling as the builder so the runtime can run
# `tsx src/index.ts ...` as the entrypoint.
RUN corepack enable
RUN npm install -g tsx

# Install ONLY production deps in the runtime stage. tests/, scripts/,
# vitest, biome, and friends never ship.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Runtime needs tsconfig.json (tsx reads paths/baseUrl from it) and src/.
COPY tsconfig.json ./
COPY src/ ./src/

# Generated state lives on the host so it survives container restarts.
VOLUME ["/app/output"]

ENTRYPOINT ["tsx", "src/index.ts"]
