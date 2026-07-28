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
ARG VITE_RPC_URL
ENV VITE_RPC_URL=$VITE_RPC_URL
ARG VITE_WAGMI_ID
ENV VITE_WAGMI_ID=$VITE_WAGMI_ID
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/templates/default.conf.template
ENV MONITORING_BACKEND=jusd-monitoring
EXPOSE 80
