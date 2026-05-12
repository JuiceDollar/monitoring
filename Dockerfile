FROM node:lts-alpine

# bw CLI is used by entrypoint.sh to fetch GUARD_PRIVATE_KEY from Vaultwarden at container start.
# Installed as root before switching user so the global npm prefix is writable.
RUN apk add --no-cache bash && npm install -g @bitwarden/cli@2024.9.0

RUN mkdir /app && chown -R node:node /app
WORKDIR /app
USER node

# Copy package files first for better layer caching
COPY --chown=node package*.json ./
RUN npm install --frozen-lockfile

# Copy source code and build
COPY --chown=node . .
RUN npm run prisma:generate
RUN npm run build

# Entrypoint optionally fetches GUARD_PRIVATE_KEY from Vaultwarden, then execs npm.
COPY --chown=node --chmod=0755 entrypoint.sh /app/entrypoint.sh

# Expose port
EXPOSE 3001

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["npm", "run", "start:migrate"]
