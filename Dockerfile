# ============================================================
# signmate — 签伴 SignMate
# Runtime 使用 Playwright 官方镜像，提供 Chromium 与浏览器依赖。
# ============================================================

FROM mcr.microsoft.com/playwright:v1.57.0-noble
ARG SIGNMATE_VERSION=0.1.33
ARG SIGNMATE_GIT_COMMIT=unknown
LABEL org.opencontainers.image.version=${SIGNMATE_VERSION} \
      org.opencontainers.image.revision=${SIGNMATE_GIT_COMMIT}
WORKDIR /app

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    WEB_PORT=9999 \
    SIGNMATE_VERSION=${SIGNMATE_VERSION} \
    SIGNMATE_GIT_COMMIT=${SIGNMATE_GIT_COMMIT}

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN npm run check:browser
COPY docker-entrypoint.sh /usr/local/bin/signmate-entrypoint
RUN chmod +x /usr/local/bin/signmate-entrypoint && mkdir -p /app/config /app/data /app/logs && chown -R pwuser:pwuser /app

EXPOSE 9999
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||9999)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER root
ENTRYPOINT ["signmate-entrypoint"]
CMD ["node", "src/index.js"]
