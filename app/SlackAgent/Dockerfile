FROM public.ecr.aws/docker/library/node:22-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY skills ./skills
COPY src ./src
RUN npm run build

FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

USER node

EXPOSE 8080 8000 9000
CMD ["node", "--require", "@opentelemetry/auto-instrumentations-node/register", "dist/src/agentcore/runtime.js"]
