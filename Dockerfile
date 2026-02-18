FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# Non-root user for security
RUN addgroup -S botuser && adduser -S botuser -G botuser
USER botuser

CMD ["node", "src/bot.js"]
