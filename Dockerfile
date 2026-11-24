# 不使用 `# syntax=` 前置指令：本文件没有 heredoc / RUN --mount 等 BuildKit 扩展语法，
# 去掉后由 BuildKit 内置前端解析，构建时不再额外拉取 docker/dockerfile 镜像。
# ---------- 构建阶段：安装全部依赖并产出 dist/ 与 server-dist/ ----------
FROM node:22-alpine AS builder

WORKDIR /app

# 先复制依赖清单，利用 Docker 层缓存：源码变化时不必重新 npm ci。
COPY package.json package-lock.json ./
RUN npm ci

# 只复制构建所需文件，测试、文档与本地配置不进镜像。
COPY index.html vite.config.ts tsconfig.json tsconfig.server.json ./
COPY src ./src
COPY public ./public
COPY server ./server

RUN npm run build

# ---------- 运行阶段：仅保留生产依赖与构建产物 ----------
FROM node:22-alpine AS runner

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server-dist ./server-dist

# PDF 中文字体：Noto CJK（含 Serif / Sans 的 TTC 集合），供服务端 pdfkit 使用。
# 字体文件固定在 /usr/share/fonts/noto/，server/lib/pdf/fonts.ts 会按该路径探测。
RUN apk add --no-cache font-noto-cjk

# calibre-web 凭据存储目录：由 compose 挂载命名卷持久化。
# 预先创建并交给 node 用户，避免非 root 运行时无法写入。
RUN mkdir -p /data && chown node:node /data
ENV CALIBRE_STORE_PATH=/data/calibre-connection.json

# 非 root 运行；node:22-alpine 自带 uid/gid 1000 的 node 用户。
USER node

EXPOSE 3000

CMD ["node", "server-dist/index.js"]
