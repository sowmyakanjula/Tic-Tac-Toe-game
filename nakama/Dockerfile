FROM node:18-alpine AS builder
WORKDIR /workspace
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM heroiclabs/nakama:3.22.0
COPY --from=builder /workspace/build/index.js /nakama/data/modules/build/index.js
COPY start.sh /nakama/start.sh
RUN chmod +x /nakama/start.sh
ENTRYPOINT ["/nakama/start.sh"]
