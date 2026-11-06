# 零第三方依赖，所以不需要 npm install。
# node_modules 不存在是有意的：镜像里只有一个 node 和几个 .js 文件，几十 MB。
FROM node:22-alpine

WORKDIR /app

# 先拷不常变的部分，改代码时缓存还能用上
COPY package.json ./
COPY vendor ./vendor
COPY src ./src
COPY config.example.json ./

ENV NODE_ENV=production \
    GATEWAY_DATA=/data \
    GATEWAY_CONFIG=/data/config.json \
    PORT=8787

# 配置和凭据都在这个卷里：删容器不丢绑定，备份就是拷这一个目录
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8787

# 用 node 自己发请求，镜像里没有 curl/wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用非 root 跑：这个进程会长期挂着处理外部消息，权限越小越好
RUN chown -R node:node /app /data
USER node

CMD ["node", "src/server.js"]
