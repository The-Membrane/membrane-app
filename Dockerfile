FROM node:18-alpine AS builder
RUN npm install -g pnpm
ENV NODE_ENV production

# Add a work directory
WORKDIR /app

# Cache and Install dependencies
COPY package.json .
COPY pnpm-lock.yaml .
# --prod=false: NODE_ENV=production would otherwise skip devDeps needed by `next build`
RUN pnpm i --frozen-lockfile --prod=false

# Copy app files
COPY . .

# Build the app
RUN pnpm run build

# Expose port
EXPOSE 3000
