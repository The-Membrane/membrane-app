FROM node:18-alpine AS builder
ENV NODE_ENV production

# Add a work directory
WORKDIR /app

# Cache and Install dependencies
COPY package.json .
COPY pnpm-lock.yaml .
RUN pnpm i

# Copy app files
COPY . .

# Build the app
RUN pnpm run build

# Expose port
EXPOSE 3000
