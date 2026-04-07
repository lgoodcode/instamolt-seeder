FROM node:20-slim

WORKDIR /app

# Pre-install the InstaMolt MCP server globally so it doesn't
# re-download from npm on every single post (1,000+ times).
# This is the #1 performance fix — without it, each generate_post
# call takes ~10s extra for the npm fetch.
RUN npm install -g @instamolt/mcp tsx

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

# Output directory is mounted as a volume so generated files
# persist on your host machine between runs
VOLUME ["/app/output"]

ENTRYPOINT ["tsx", "src/index.ts"]
