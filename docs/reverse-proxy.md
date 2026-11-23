# Running behind a TLS reverse proxy

`keygate-server` serves plain HTTP on `KEYGATE_PORT`. It has no TLS stack of
its own, by design: termination belongs in the proxy, where certificates are
managed and rotated. This page is the recipe for putting one in front of it.

## Publish the backend on loopback only

The container's port must not be reachable except through the proxy. Bind it
to loopback:

```bash
docker run --rm \
  -p 127.0.0.1:8080:8080 \
  -e KEYGATE_SOROBAN_RPC_URL=https://your-rpc.example \
  -e KEYGATE_CORE_CONTRACT=C... \
  -e KEYGATE_POLICY_CONTRACT=C... \
  -e KEYGATE_BREAKER_CONTRACT=C... \
  keygate-server
```

`-p 8080:8080` without the address binds every interface, which is how a
"private" backend ends up on the internet. With `127.0.0.1:` in front, only
processes on the same host can reach it — the proxy, and nothing else. If the
proxy runs on another host, put the backend on a private network instead and
firewall the port so only the proxy's address can connect.

## Caddy

Caddy terminates TLS automatically (it provisions a certificate for the
domain) and forwards to the loopback backend:

```caddy
keygate.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

That is the whole configuration. Caddy forwards the `Authorization` header
unchanged, so bearer tokens reach the service, and it sets `X-Forwarded-For`
and `X-Forwarded-Proto` for the logs.

## nginx

The same shape, with certificates managed separately (for example by
certbot):

```nginx
server {
    listen 443 ssl;
    server_name keygate.example.com;

    ssl_certificate     /etc/letsencrypt/live/keygate.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/keygate.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`proxy_set_header Authorization $http_authorization;` is explicit rather
than relied on: if a proxy strips the header, every authenticated request
fails with `401 {"error":"unauthorized"}` and the failure looks like a bad
token rather than a proxy misconfiguration.

## Three different things, not one

Operators confuse these; they protect different links:

- **Bearer tokens (`KEYGATE_API_TOKENS`) authenticate the caller to the
  service.** Without a token, `/v1/*` answers `401`. With one, the service
  knows the request came from someone holding a credential it issued. Tokens
  are never logged.
- **TLS encrypts the transport.** It stops anyone between the caller and the
  proxy from reading or changing the request. It does not authenticate the
  caller, and it does not prove anything about the answer.
- **Signed decisions (`KEYGATE_SIGNING_KEY`) prove the answer came from this
  service.** The HMAC in `x-keygate-signature` lets a downstream service check
  that a decision was issued for _this_ holder and _this_ amount, and cannot
  be replayed for someone else after passing through a proxy or a CDN. **HMAC
  signing does not encrypt traffic.** A signed decision sent over plain HTTP
  is still readable in transit; that is what TLS is for.

A deployment needs all three where they apply: TLS on the public side,
bearer tokens on `/v1/*`, and signing when a decision crosses a trust
boundary to another service.

## Health, readiness and metrics stay open

`/healthz`, `/readyz` and `/metrics` are unauthenticated by design, so a
load balancer and a Prometheus scraper can probe them without a credential.
That is safe because they carry no secrets: `/healthz` says the process is
up, `/readyz` says whether the mirror is fresh, and `/metrics` carries
counts and gauges only — no holder addresses and no resource names, so there
is nothing in them to enumerate. Do not put a token in front of them; the
load balancer cannot present one.

## Checking it works

```bash
# Through the proxy, with TLS: health and readiness need no token.
curl -s https://keygate.example.com/healthz
# {"status":"ok"}

curl -s https://keygate.example.com/readyz
# {"ready":true,"stalenessSeconds":4}

# Authenticated routes need a token (placeholder, never a real one).
curl -s https://keygate.example.com/v1/status \
  -H 'Authorization: Bearer <your-32-plus-character-token>'

# Direct backend access must fail: nothing listens on the public interface.
curl -s --max-time 2 http://keygate.example.com:8080/healthz \
  && echo "backend is reachable directly — fix the publishing"
```

If the direct-access check prints a response, the port is published on a
public interface. Re-run with `127.0.0.1:8080:8080` and check again.
