FROM node:20-bookworm
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY board-agent.mjs ./
EXPOSE 8090
CMD ["node", "board-agent.mjs"]
