FROM node:lts-alpine AS build
WORKDIR /app/frontend
# The walletconnect tree (wallet delegation in the guard section) pulls ws' native addons
# bufferutil / utf-8-validate; node-gyp needs python3/make/g++ to build them on alpine, or npm ci
# fails. Build stage only — none of this reaches the nginx image below.
RUN apk add --no-cache python3 make g++
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
COPY shared/ /app/shared/
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ARG VITE_DEPLOYMENT_ENV
ENV VITE_DEPLOYMENT_ENV=$VITE_DEPLOYMENT_ENV
# Wallet config for the guard delegation section. Both values are PUBLIC by nature — they are baked
# into the browser bundle and visible to anyone who opens the dashboard — so they belong here as
# defaults rather than in deployment secrets, the same way VITE_API_BASE_URL does above. Override per
# build with --build-arg if a deployment needs a different endpoint or project.
# The Citrea RPC is the same public endpoint the backend uses and answers browser requests
# (access-control-allow-origin: *). The WalletConnect project id identifies the dapp to the relay.
#
# COUPLING: the delegate action builds its chain from the chain id the BACKEND reports at /guard, while
# this RPC URL is fixed here. Repointing the backend at another network (BLOCKCHAIN_ID / RPC_URL) without
# overriding VITE_RPC_URL in the same breath leaves the wallet transport talking to Citrea while the
# declared chain id says otherwise — transactions can look unconfirmed in the UI. Change both together.
ARG VITE_RPC_URL=https://rpc.citreascan.com
ENV VITE_RPC_URL=$VITE_RPC_URL
ARG VITE_WAGMI_ID=b49c3a590c4407316a6fd6eae6531e90
ENV VITE_WAGMI_ID=$VITE_WAGMI_ID
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/templates/default.conf.template
ENV MONITORING_BACKEND=jusd-monitoring
EXPOSE 80
