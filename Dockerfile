FROM node:23-slim

# add a non-privileged user for running the application
RUN groupadd --gid 10001 app && \
    useradd -g app --uid 10001 --shell /usr/sbin/nologin --create-home --home-dir /app app

WORKDIR /app

COPY package.json ./
RUN npm install --no-package-lock; \
  npm cache clean --force

# copy sources
COPY update_remote_settings_records.mjs ./

USER app

# set CMD
CMD ["node", "update_remote_settings_records.mjs"]
