FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/mechanism/package.json packages/mechanism/
COPY packages/middleware/package.json packages/middleware/
COPY packages/client/package.json packages/client/
COPY packages/demo/package.json packages/demo/
RUN bun install --frozen-lockfile

# Copy source
COPY packages/ packages/

EXPOSE 4402
CMD ["bun", "run", "./packages/demo/src/aztec/real-server.ts"]
