# Base image
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY . .

# Expose backend port
EXPOSE 5000

# Set environment
ENV NODE_ENV=production
ENV PORT=5000

# Start server
CMD ["node", "index.js"]

