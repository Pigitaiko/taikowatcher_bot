FROM node:20-alpine

WORKDIR /app

# Build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Data directory for SQLite
RUN mkdir -p /app/data

# Non-root user for security
RUN addgroup -S botuser && adduser -S botuser -G botuser
RUN chown -R botuser:botuser /app/data
USER botuser

EXPOSE 10000

CMD ["node", "src/bot.js"]
