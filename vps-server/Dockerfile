# License server for Za Post Comment Tool — deploy on Coolify (Dockerfile build pack).
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# Keys live on a PERSISTENT volume so they survive redeploys (mount a volume at /data).
ENV KEYS_PATH=/data/keys.json
ENV PORT=3509
EXPOSE 3509
CMD ["node", "license-server.js"]
