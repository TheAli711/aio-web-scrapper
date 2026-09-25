# Render build of upstream Firecrawl's nuq-postgres (queue DB) at the SHA pinned in firecrawl.lock.
# Upstream publishes this image only as :latest, so we build it from the pinned source instead.
# Steps mirror firecrawl/apps/nuq-postgres/Dockerfile; upstream code is not modified.
# Build context: repository root.  docker build -f infra/render/nuq-postgres.Dockerfile .
ARG PG_MAJOR=17
FROM alpine/git:2.47.2 AS src
ARG FIRECRAWL_REPO=https://github.com/firecrawl/firecrawl.git
ARG FIRECRAWL_SHA=ef12eb36b2f3382838dfe0a0c1a5add3d5df7fe5
RUN git init -q /src && cd /src \
 && git remote add origin "$FIRECRAWL_REPO" \
 && git fetch -q --depth 1 origin "$FIRECRAWL_SHA" \
 && git checkout -q FETCH_HEAD

FROM postgres:${PG_MAJOR}
ARG PG_MAJOR=17
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-${PG_MAJOR}-cron; \
    rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    conf_sample="/usr/share/postgresql/${PG_MAJOR}/postgresql.conf.sample"; \
    sed -ri "s/^#?shared_preload_libraries\s*=.*/shared_preload_libraries = 'pg_cron'/" "$conf_sample"; \
    printf "\n# Added for pg_cron\ncron.database_name = 'postgres'\n" >> "$conf_sample"
COPY --from=src /src/apps/nuq-postgres/nuq.sql /docker-entrypoint-initdb.d/010-nuq.sql
# Render mounts the persistent disk at /var/lib/postgresql/data; initdb needs an empty subdirectory
# (the disk root holds lost+found).
ENV PGDATA=/var/lib/postgresql/data/pgdata
