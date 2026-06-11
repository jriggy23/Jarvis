# syntax=docker/dockerfile:1

###############################################################################
# Builder: install all deps, compile TypeScript -> dist/
###############################################################################
FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies only for the runtime image.
RUN npm prune --omit=dev

###############################################################################
# Runtime: slim image with compiled output + production node_modules
###############################################################################
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Container App ingress target_port = 80; the app listens on 80.
EXPOSE 80
CMD ["node", "dist/index.js"]
