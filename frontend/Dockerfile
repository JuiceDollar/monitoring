FROM node:lts-alpine AS build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
COPY shared/ /app/shared/
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/templates/default.conf.template
ENV MONITORING_BACKEND=jusd-monitoring
EXPOSE 80
