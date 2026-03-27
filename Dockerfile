# Use official Node.js LTS image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# Create downloads directory
RUN mkdir -p downloads

# Expose port (Fly.io sets PORT env var automatically)
EXPOSE 8080

# Start
CMD ["node", "server.js"]
