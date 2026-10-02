# Deploying on Render

Production runs in the Render project **webscrapper** (environment `production`, region Oregon,
network isolation enabled). Render clones the public repository and has no GitHub access, so a
push does not deploy anything: trigger each service's deploy with `POST /v1/services/<id>/deploys`.

| Render service             | Type            | Source                                               | Plan     |
|----------------------------|-----------------|------------------------------------------------------|----------|
| `webscrapper-web`          | web service     | `apps/web/Dockerfile`                                | starter  |
| `webscrapper-api`          | private service | `apps/api/Dockerfile`, disk `/data` (object store)   | starter  |
| `webscrapper-db`           | Postgres 16     | managed                                              | basic_256mb |
| `webscrapper-firecrawl`    | private service | image `ghcr.io/firecrawl/firecrawl:sha-ef12eb36b2f3-linux-amd64` | pro |
| `webscrapper-playwright`   | private service | `infra/render/playwright-service.Dockerfile`         | standard |
| `webscrapper-nuq-postgres` | private service | `infra/render/nuq-postgres.Dockerfile`, disk         | starter  |
| `webscrapper-redis`        | private service | image `redis:7-alpine` (no persistence)              | starter  |
| `webscrapper-rabbitmq`     | private service | image `rabbitmq:3-management`                        | starter  |
| `webscrapper-egress-proxy` | private service | `apps/egress-proxy/Dockerfile`                       | starter  |
| `webscrapper-brand`        | private service | `apps/brand-service/Dockerfile`                      | standard |
| `webscrapper-traffic-db`   | Postgres 16     | managed, 15 GB                                       | basic_1gb |
| `webscrapper-traffic-api`  | private service | `apps/traffic-estimator/Dockerfile` (context `apps/traffic-estimator`) | starter |
| `webscrapper-traffic-worker` | background worker | same image, `python -m traffic_estimator worker`, disk `/data/traffic` 15 GB | standard |
| `webscrapper-traffic-scheduler` | background worker | same image, `python -m traffic_estimator scheduler` | starter |

Only `webscrapper-web` is public; everything else is reachable only on the environment's private
network (`<service-slug>:<port>`). The environment variables mirror `docker-compose.yml`.

## Pinning

The Firecrawl engine image is pinned by the upstream commit tag matching `firecrawl.lock`. Upstream
publishes `playwright-service` and `nuq-postgres` only as `:latest`, so `infra/render/*.Dockerfile`
clone upstream at the pinned SHA and repeat the upstream build steps. When upgrading Firecrawl,
update the SHA in `firecrawl.lock`, both `infra/render/*.Dockerfile` files, and the image tag on
`webscrapper-firecrawl`.

## Difference from the compose stack

Docker Compose puts the engine on an `internal` network with no route out, so `egress-proxy` is the
only way to the internet. Render private services always have outbound internet access. The engine
is still configured to send all target fetches through `egress-proxy` (which applies the SSRF
policy), and the API still pre-checks every URL, but nothing at the network layer stops a
direct connection.

## Traffic estimates

`/api/v1/traffic` on `webscrapper-api` calls the traffic estimator (`apps/traffic-estimator`) over
the private network: `TRAFFIC_API_URL=http://webscrapper-traffic-api:4200` (unset: the endpoints
answer `503 TRAFFIC_UNAVAILABLE`). `TRAFFIC_WAIT_MS` (default 60000) caps `?wait=true`.

The three estimator services share one image and these variables: `TE_DATABASE_URL` (the
`webscrapper-traffic-db` internal connection string with the `postgresql+psycopg://` scheme),
`TE_DATA_DIR=/data/traffic`, `TE_HTTP_PROXY=http://webscrapper-egress-proxy:3128` with
`TE_HTTP_PROXY_USERNAME`/`TE_HTTP_PROXY_PASSWORD` (the proxy's `PROXY_USERNAME`/`PROXY_PASSWORD`;
the crawler fetches user-supplied domains, so it must go through the SSRF-enforcing proxy),
`TE_ENABLED_COLLECTORS=["lists","crawl","dns"]`, `TE_LIST_PROVIDERS`, `TE_WORKER_CONCURRENCY=8`,
`TE_CRAWL_PAGES=15`, `TE_LOG_LEVEL=info`. `TE_MIGRATE_ON_START` is `true` on the API only, so
deploy the API before the worker and scheduler on a fresh database.

The worker and scheduler commands start with `/app/docker-entrypoint.sh`: it chowns the
root-owned disk, then runs the process as `app`. On a fresh disk the scheduler queues all list
downloads (~2.8 GB, through the egress proxy) and the worker builds the web-graph index; domains
submitted meanwhile wait (`lists` tasks defer) and complete once the lists are in.

## Accounts

`ALLOW_SIGNUP` on `webscrapper-api` controls self-service sign-up. Keep it `false` once the operator
accounts exist.
