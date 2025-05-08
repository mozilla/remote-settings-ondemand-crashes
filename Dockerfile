FROM oven/bun:1

# add a non-privileged user for running the application
RUN groupadd --gid 10001 app && \
    useradd -g app --uid 10001 --shell /usr/sbin/nologin --create-home --home-dir /app app

WORKDIR /app

COPY bun.lock .
COPY package.json .

RUN bun install --production --frozen-lockfile

# copy sources
COPY src ./src

USER app

CMD ["bun", "src/main.ts"]
