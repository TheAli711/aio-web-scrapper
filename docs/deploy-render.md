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
the private network. Set on `webscrapper-api`:

| Variable | Value |
|---|---|
| `TRAFFIC_API_URL` | `http://<traffic-api service slug>:4200` |
| `TRAFFIC_WAIT_MS` | optional, default `60000` (cap for `POST /traffic?wait=true`) |

Unset, the endpoints answer `503 TRAFFIC_UNAVAILABLE` ("not enabled on this server"). The
estimator itself is not deployed on Render yet. It needs its own API (private service), worker
(background worker with a disk of at least 10 GB for the ranked lists and the web-graph index),
scheduler and Postgres, with the `TE_*` variables from `docker-compose.yml`; the worker reaches
the internet through `webscrapper-egress-proxy` (`TE_HTTP_PROXY`).

## Accounts

`ALLOW_SIGNUP` on `webscrapper-api` controls self-service sign-up. Keep it `false` once the operator
accounts exist.
