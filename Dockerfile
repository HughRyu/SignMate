# ============================================================
# signmate — 签伴 SignMate
# Runtime 使用 Playwright 官方镜像，提供 Chromium 与浏览器依赖。
# ============================================================

FROM mcr.microsoft.com/playwright:v1.57.0-noble
WORKDIR /app

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    WEB_PORT=9999 \
    CHROMIUM_PATH=/ms-playwright/chromium-1200/chrome-linux64/chrome

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
COPY docker-entrypoint.sh /usr/local/bin/signmate-entrypoint
RUN chmod +x /usr/local/bin/signmate-entrypoint && mkdir -p /app/config /app/data /app/logs && chown -R pwuser:pwuser /app

EXPOSE 9999
USER root
ENTRYPOINT ["signmate-entrypoint"]
CMD ["node", "src/index.js"]
