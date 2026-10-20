# The worker and the janitor, for Railway (or any container host).
#
# One image, two services: Railway starts it as `node worker.js` for the
# worker and `node janitor.js` for the janitor (railway.json and
# railway.janitor.json). The Next.js app is not in here — it runs on
# Vercel, which cannot hold the worker's IMAP connections open.
#
# Node 22: stream-json's stream-chain needs it.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Stockholm

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY worker.js janitor.js ./

# Railway sends SIGTERM on redeploy; the worker closes every mailbox
# and exits on it (worker.js).
CMD ["node", "worker.js"]
