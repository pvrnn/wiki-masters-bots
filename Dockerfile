# syntax=docker/dockerfile:1

# The image tag must match the "playwright" version in package.json -- a
# mismatch between the client and the bundled browsers is a common breakage.
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.56.1-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Real Google Chrome rather than bundled Chromium: a noticeably better
# fingerprint against Cloudflare Turnstile. Needs root, so it happens before
# the USER switch below.
RUN npx playwright install chrome

COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R pwuser:pwuser /app

# Everything stateful lives under the mounted volume.
ENV WM_STATE_PATH=/app/data/storage-state.json \
    WM_META_PATH=/app/data/session-meta.json \
    WM_PROFILE_DIR=/app/data/profile \
    WM_LOCK_PATH=/app/data/bot.lock \
    WM_LEDGER_PATH=/app/data/auth-ledger.json \
    WM_DEBUG_DIR=/app/data/debug \
    WM_HEADLESS=false

VOLUME ["/app/data"]
USER pwuser

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["daemon"]
