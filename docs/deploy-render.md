# Deploying on Render

Production runs in the Render project **webscrapper** (environment `production`, region Oregon,
network isolation enabled). Every service auto-deploys from `main`.

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

## Accounts

`ALLOW_SIGNUP` on `webscrapper-api` controls self-service sign-up. Keep it `false` once the operator
accounts exist.
