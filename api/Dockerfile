FROM node:18-alpine

LABEL maintainer="DLUX Team"
LABEL description="Enhanced DLUX Presence Infrastructure"

# Create app directory
WORKDIR /app

# Create logs directory
RUN mkdir -p logs

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S dlux -u 1001

# Change ownership
RUN chown -R dlux:nodejs /app
USER dlux

# Expose port
EXPOSE 3000

# Health check with shorter timeout to avoid interfering with shutdown
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=2 \
  CMD node -e "const http = require('http'); \
    const options = { host: 'localhost', port: 3000, path: '/health', timeout: 3000 }; \
    const req = http.request(options, (res) => { \
      if (res.statusCode === 200) process.exit(0); \
      else process.exit(1); \
    }); \
    req.on('error', () => process.exit(1)); \
    req.on('timeout', () => process.exit(1)); \
    req.end();"

# Start the application with proper signal handling
CMD ["node", "index.js"] 