FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile --production
COPY . .
ARG GIT_SHA=local
ENV NODE_ENV=production GIT_SHA=${GIT_SHA}
USER bun
CMD ["bun", "src/index.tsx"]
