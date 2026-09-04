# pi-bob

An [IBM Bob](https://bob.ibm.com) provider for the [pi coding agent](https://pi.dev),
with browser SSO login and automatic token refresh.

Bob's `/inference/v1` is an OpenAI-compatible LiteLLM proxy, so pi can talk to it
through the built-in `openai-completions` channel. This extension supplies the
three things pi does not do out of the box: the SSO login flow, the two routing
headers the gateway requires, and a User-Agent the WAF in front of it accepts.

> Not affiliated with or endorsed by IBM. You need your own Bob account; the
> extension only automates the same login your browser already performs.

## Install

```bash
pi install git:github.com/fdddf/pi-bob
```

Then, inside pi:

```
/login bob
```

A browser tab opens for IBM SSO. When it comes back, pi stores the credentials in
`~/.pi/agent/auth.json` and refreshes them on its own before they expire.

```bash
pi --model bob/premium-ide
```

To develop against a checkout instead:

```bash
git clone https://github.com/fdddf/pi-bob && cd pi-bob
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-bob
```

## Configuration

| Env var | Default |
|---|---|
| `VITE_GATEWAY_BASE_URL` | `https://api.us-east.bob.ibm.com` |
| `VITE_WEB_LOGIN_URL` | `https://bob.ibm.com` |

Same names Bob's own CLI reads, so an existing environment carries over.

## How it works

The login is not standard OAuth — there is no `client_id`, no PKCE and no
`/authorize` endpoint. Bob hands the client a one-shot code on a loopback
callback and trades it for a JWT:

1. Bind an ephemeral port on `127.0.0.1` and listen on `/bob-callback`.
2. Open `{webLogin}/login?callback_uri=...&state=...`.
3. The browser returns `?code=...&state=...`.
4. `POST {gateway}/authn/v1/auth/token` `{"code": ...}` → `{token, refresh_token}`.
5. `POST {gateway}/authn/v1/auth/refresh` `{"refresh_token": ...}` to renew;
   the refresh token rotates on every call.

`token` is the JWT sent as `Authorization: Bearer …`; its `exp` claim drives
pi's refresh scheduling. The gateway additionally requires `x-instance-id` and
`x-team-id` for routing and budgeting. The instance id is in the JWT, but the
team id is not, so `login()` and `refreshToken()` each fetch
`GET /admin/v1/profile` and cache both ids to
`~/.pi/agent/bob-instance-id` and `~/.pi/agent/bob-team-id`, which the provider
reads back per request via pi's `!cat` header syntax.

Accounts with more than one instance or team are not handled yet — the first of
each is used.

## Models

Only `premium-ide` is declared. To see everything your account can reach:

```bash
curl -s https://api.us-east.bob.ibm.com/inference/v1/model/info \
  -H "Authorization: Bearer $(jq -r '.bob.access' ~/.pi/agent/auth.json)" \
  -H "x-instance-id: $(cat ~/.pi/agent/bob-instance-id)" \
  -H "x-team-id: $(cat ~/.pi/agent/bob-team-id)" \
  -H 'User-Agent: Mozilla/5.0 (compatible; bob-client/1.0)'
```

Note that `model/info` reports cost **per token** while pi's `cost` field is
**per million tokens**.

## Caveats

- The gateway validates the request body strictly: any property it does not know
  — `tools[].function.strict`, `store`, `max_completion_tokens` — comes back as a
  `422` that pi surfaces as `Error: 422 status code (no body)`. The model's
  `compat` block turns those off. Note that pi reads `compat` per **model**, not
  per provider; a `compat` on the provider object is silently ignored.
- pi speaks the OpenAI wire format, so Anthropic `cache_control` blocks are never
  sent. Prompt caching does not apply and cost will be higher than Bob's own CLI.
- pi does not report usage to Bob's telemetry endpoint; the gateway's own
  accounting is the source of truth.
- `pi auth check --provider bob` does not load extensions and always reports
  `provider_not_found`. Use `pi -p hi --provider bob` to verify the provider
  loaded — `No API key found for bob` means it did.

## License

MIT
