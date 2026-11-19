# big-spender

See what your AI coding agents would cost at API prices, summed across all your machines.

Each machine runs a small collector every hour. It reads that machine's Claude Code and Codex
session logs, works out hourly token and cost totals at [LiteLLM](https://github.com/BerriAI/litellm)
API prices, and posts one snapshot (the last 90 days) to a server you run. The server merges each
snapshot into that device's stored history, adds the devices together, and serves the totals as
JSON and as a plain HTML page. You can also embed the server side in your own app and draw the
numbers however you like.

![A 30-day bar chart of daily AI coding cost, each bar stacked by machine (MacBook, VPS, Home agent), with a $3,148 total](docs/usage-card.png)

The card above is on [jeffreyyvdb.com](https://jeffreyyvdb.com). The site mounts
`big-spender/server` and draws its own chart from the summary, here 30 days of daily cost stacked
by machine.

Cursor keeps usage on its servers, so one machine can also read your Cursor account's usage from
Cursor's API and send it as its own device. See [Cursor](#cursor).

The collector has no dependencies and needs Node 20 or newer. The package depends on `zod` only.

## What leaves the machine

Only numbers, model names, UTC timestamps, the device id and the pricing source. No paths, working
directories, prompts, session ids or git branches. Session ids are hashed on the device and only
their counts are sent. The server rejects any snapshot with extra fields, so nothing else can be
stored or served even by a modified collector.

The server never publishes a device's report time (it would show when each machine is online), and
nothing is bucketed finer than a UTC day: 7, 30 and 90 days are per day, all time is per ISO week
(Monday UTC). Device ids are published only if you leave
`unknownDevices` at its default, see [Device names and colours](#device-names-and-colours).

Before the first send you can see exactly what would leave the machine with
`big-spender push <device> --dry-run`.

With [Cursor](#cursor) set up, the collector also calls Cursor's API with your Cursor API key. It
sends Cursor only the key and a date range. From the answer it keeps model names, token counts,
cost and timestamps, the same as from local logs. Conversation ids are hashed on the device and
only counted, like session ids. Everything else in the answer, such as your Cursor user id, is
dropped.

## Quick start

### 1. Run the server

With Docker:

```sh
docker build -t big-spender .
docker run -d -p 8787:8787 \
  -e BIG_SPENDER_INGEST_TOKEN="$(openssl rand -hex 32)" \
  -v big-spender-data:/data \
  big-spender
```

Or with Node:

```sh
export BIG_SPENDER_INGEST_TOKEN="$(openssl rand -hex 32)"
npx big-spender serve --port 8787 --data ./data
```

Keep the token: every collector needs it. Open `http://localhost:8787/` for the page and
`http://localhost:8787/api/usage` for the JSON. Without a token the server still runs, but ingest
answers `503`.

Put the server behind HTTPS (a reverse proxy is enough) before collectors on other machines post to
it. The token travels in an `Authorization` header.

### 2. Install the collector on each machine

```sh
npx big-spender install --device laptop --url https://example.com/api/usage/ingest
```

It asks for the token with a hidden prompt (or reads `BIG_SPENDER_INGEST_TOKEN` from the
environment, or the existing env file). There is deliberately no flag for it, so it never ends up
in your shell history or process list. Then it:

1. copies the collector to `~/.local/share/big-spender/collector.mjs`,
2. writes `~/.config/big-spender/env` (mode 600) with the device id, URL and token,
3. schedules it hourly, and runs it once.

The device id is a lowercase slug (`laptop`, `desktop`, `build-box`). Run the command again any
time to update the installed copy or change the URL; it converges to the same state.

The id is fixed once a machine has one. `install --device <other>` stops with an error, because the
server keeps the old id's `<id>.json` and would count the same 90 days again under the new id. If
you do mean to rename the device, pass `--rename` and delete the old device's file on the server.

| System | Schedule                                                                                                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux  | systemd user units `big-spender.service` and `big-spender.timer` (`OnCalendar=hourly`, `Persistent=true`). Log: `journalctl --user -u big-spender`. On a headless box, `loginctl enable-linger $USER` keeps the timer running while logged out. |
| macOS  | LaunchAgent `~/Library/LaunchAgents/local.big-spender.plist` (minute 0 of every hour, and at login; a run missed during sleep fires on wake). Log: `~/Library/Logs/big-spender.log`.                                                            |

Remove the schedule with `big-spender uninstall`. The env file and the state are kept.

`big-spender status` prints the last 24 hours on this machine and sends nothing.

### Cursor

Cursor keeps usage on its servers, per account, so the collector reads it from Cursor's API
instead of local files. The server must run the big-spender release that added Cursor, or newer.
An older one answers the `cursor` snapshot with `422`. Set it up on one machine only:

```sh
npx big-spender install --device laptop --cursor
```

Only the account's personal usage is read. Usage billed to a Cursor team is not read yet.

It asks for a Cursor user API key with a hidden prompt (or reads `BIG_SPENDER_CURSOR_API_KEY`) and
adds it to the env file. Create the key in your Cursor dashboard. Running `install` again without
`--cursor` keeps the key; with `--cursor` it asks for a new one.

Cursor usage is sent as its own device, `cursor`, not as the machine that reads it, because one
account covers every machine you use Cursor on. If you move the key to another machine, remove it
from the first one, or both would send the same usage. Add `cursor` to your
[devices file](#device-names-and-colours) to give it a name and colour.

The first run sends all of the account's history that has token counts. Cursor billed per request
until about June 2025 and reported no tokens for those events, so they are skipped. Later runs
send the last 90 days, and the server keeps the older days. The full history is sent again until a
server has stored it, so a failed first run, a new ingest URL or a new API key gets it on the next run.

Cost is Cursor's own price for each event (`totalCents`), not LiteLLM's. Cursor's model names
mostly don't match LiteLLM's, and models such as Composer have no API price at all. Cursor reports
one price per event, so the split over input, cache read, cache write and output uses fixed ratios
of 1, 0.1, 1.25 and 5. The total is Cursor's, up to rounding each part to a millionth of a dollar.

A Cursor failure, such as a revoked key, does not stop the machine's own snapshot. The run still
posts it, then exits with an error that names Cursor. That includes a Cursor answer with fewer
events than it counted: posting it would replace complete days on the server with partial ones. The device
id `cursor` is reserved for this snapshot, so no machine can report under it. To switch to
another Cursor account, stop the server, remove `cursor.json` from its data directory and start it
again before the new key's first run. The server keeps snapshots in memory, so removing the file
while it runs is not enough, and the two accounts' histories would be merged. `big-spender push` never
reads Cursor.

## The server

`big-spender serve` is a small `node:http` server:

| Route                    | What it does                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/usage/ingest` | Collectors post a snapshot here (gzip or plain JSON, bearer token).                                                                          |
| `GET /api/usage`         | Merged totals for 7, 30 and 90 days and all time as JSON, with `cache-control: public, max-age=300, stale-while-revalidate=900`.             |
| `GET /`                  | A plain server-rendered page: totals per range, devices with colour swatches, top models. No JavaScript, no external assets, light and dark. |
| `GET /healthz`           | `ok`, for load balancers and Docker.                                                                                                         |

Configuration comes from flags or environment variables (flags win):

| Flag        | Environment                | Default                                              |
| ----------- | -------------------------- | ---------------------------------------------------- |
| `--port`    | `PORT`                     | `8787`                                               |
| `--host`    | `HOST`                     | `0.0.0.0`                                            |
| `--data`    | `BIG_SPENDER_DATA_DIR`     | `./data` (`/data` in the Docker image)               |
| `--devices` | `BIG_SPENDER_DEVICES_FILE` | none: `{ "devices": {}, "unknownDevices": "by-id" }` |
|             | `BIG_SPENDER_INGEST_TOKEN` | none: ingest is off and answers `503`                |

The data directory holds one `<device>.json` file per device, written atomically. Put it on a
persistent volume. Each snapshot is merged into the device's stored history. A day the snapshot
reports replaces that day for each provider and model. Days it does not report are kept as day
rows, so the server keeps usage from beyond the collector's 90-day window, and the all-time range
shows it. All time has no session count (`sessions: null`): collectors count distinct sessions
on the device for 7, 30 and 90 days only. A device file holds at most 50,000 rows. Past that, the oldest kept days are dropped
and the server logs a warning. A snapshot older than the stored one is ignored (`"result":
"stale"`), so retries and duplicate posts are harmless. Files in the directory that are not valid snapshots are ignored with a warning.

Ingest limits: request bodies up to 2 MB, 16 MB after decompression, `gzip` or `identity` encoding
only. An invalid snapshot gets `422` with the first five problems. Dates before 2020-01-01 are
invalid.

### Device names and colours

Collectors identify themselves by device id. The server maps each id to the name and colour it
publishes. Point `--devices` at a JSON file:

```json
{
	"devices": {
		"laptop": { "name": "Laptop", "color": "#7fa034" },
		"desktop": { "name": "Desktop", "color": "#3899e2" }
	},
	"unknownDevices": "by-id"
}
```

Devices are listed in the order you write them. A device that is not listed is, by default,
shown under its own id with the next free colour. Set `"unknownDevices": "other"` to merge all
unlisted devices into one "Other" line instead, so no id is ever published. Use this when ids are
hostnames you would rather keep private.

## Embed it in your own app

`big-spender/server` is the same code the standalone server runs, behind web-standard `Request` and
`Response` objects, so any framework can mount it. SvelteKit:

```ts
// src/lib/server/usage.ts
import { createBigSpender } from 'big-spender/server';
import { env } from '$env/dynamic/private';

export const bs = createBigSpender({
	dataDir: env.USAGE_DATA_DIR ?? 'data/usage',
	ingestToken: env.USAGE_INGEST_TOKEN,
	devices: { devices: { laptop: { name: 'Laptop', color: '#7fa034' } }, unknownDevices: 'other' }
});

// src/routes/api/usage/ingest/+server.ts
import { bs } from '$lib/server/usage';
export const POST = ({ request }) => bs.ingest(request);

// src/routes/api/usage/+server.ts
import { json } from '@sveltejs/kit';
import { bs } from '$lib/server/usage';
export const GET = async ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=300, stale-while-revalidate=900' });
	return json(await bs.summary());
};
```

Hono is the same shape (`app.post('/api/usage/ingest', (c) => bs.ingest(c.req.raw))`), and so is a
Next.js route handler (`export const POST = (request: Request) => bs.ingest(request)`).

`createBigSpender({ dataDir, ingestToken, devices })` returns:

- `ingest(request)`: handles a collector's `POST` and returns a `Response` (`503` when
  `ingestToken` is missing or empty, `401`, `413`, `415`, `422`, or `200` with
  `{ ok, deviceId, rows, result: 'stored' | 'stale' }`).
- `summary(now?)`: the merged totals for every range. The result is cached for five minutes and
  recomputed right after an ingest.

The module also exports `summarize(snapshots, now, config)`, the snapshot schema
(`usageSnapshotSchema`), `resolveDevices`, `RANGES`, `PROVIDERS` and the types, for building your
own storage or charts.

## Push by hand

For a machine that should only report now and then, or where you would rather not store a token:

```sh
big-spender push laptop --dry-run   # review only: per-model overview, the exact JSON, never sends
big-spender push laptop             # same review, then asks before sending
```

It builds the snapshot and lists the model names it would publish. It stops if a name looks like a
cloud resource id or gateway path (it contains `arn:` or `/`), such as a Bedrock inference-profile
ARN with an account id in it. It asks before sending, sends exactly the JSON it showed, and takes
the URL from `--url`, `BIG_SPENDER_INGEST_URL` or a prompt, and the token from
`BIG_SPENDER_INGEST_TOKEN` or a hidden prompt. Neither is stored. Nothing is scheduled, so the
server shows that device's usage as of its last push.

`--dry-run` writes the JSON that would be sent to `$TMPDIR/big-spender-snapshot-<device>.json`.

## Check the numbers

```sh
big-spender status                          # last 24 hours on this machine, nothing sent
node ~/.local/share/big-spender/collector.mjs --dry-run   # the full snapshot JSON, nothing sent
```

With [Cursor](#cursor) set up, `--dry-run` reads Cursor too and prints the `cursor` snapshot after
this machine's.

Compare with [ccusage](https://github.com/ryoppippi/ccusage) on the same machine. Use the `claude`
subcommand: plain `npx ccusage` also adds other CLIs that the collector does not read. Claude Code
tokens and cost should match per model:

```sh
npx ccusage@latest claude daily --since 20260819 --breakdown
```

ccusage groups by local date and the collector by UTC hour, so single days can shift a little at the
edges. Tools that price every cache write at the 5-minute rate and ignore long-context prices show
about 15 to 20 percent less.

## How it counts

| Source      | Files                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/**/*.jsonl`, `~/.config/claude/projects`, `$CLAUDE_CONFIG_DIR/projects` | `assistant` lines; de-duplicated by `message.id` + `requestId` (one API response is logged once per content block, and resumed sessions copy history). `<synthetic>` skipped; subagent logs included. Some Claude Code versions (2.1.293 to 2.1.310) log a partial output count on a message's first line and the final count on a later line; a later line that reports more output adds the difference. |
| Codex       | `~/.codex/sessions/**/rollout-*.jsonl`, `$CODEX_HOME/sessions`                              | `event_msg` / `token_count` with `info.last_token_usage`; skipped when `total_token_usage` did not change. Model from the latest `turn_context`. `cached_input_tokens` is part of `input_tokens`; reasoning is part of `output_tokens`.                                                                                                                                                                   |
| Cursor      | Cursor's API, `DashboardService/GetFilteredUsageEvents`, with `BIG_SPENDER_CURSOR_API_KEY`  | Events with token counts only. Cost is Cursor's `totalCents`. Events have no unique id and pages can overlap, so a time window with more than 1,000 events is split in half instead of paged. `cacheWriteTokens` count as 5-minute cache writes. Sessions are hashed `conversationId`s. Model names are lowercased, and anything outside `a-z 0-9 . _ : @ -` becomes `-`.                                 |

**Pricing.** Claude Code and Codex use LiteLLM `model_prices_and_context_window.json`, cached for 24 hours in
`~/.cache/big-spender/`. Lookup tries the exact model, then `anthropic/` or `openai/` prefixes, then
without a date suffix. Unknown models count with cost 0 and log a warning. Long-context tiers
(`*_above_<N>k_tokens`) are applied per request; 1-hour cache writes use
`cache_creation_input_token_cost_above_1hr`. Cache savings are cache-read tokens times (input price
minus cache-read price).

**Incremental.** `~/.cache/big-spender/state.json` keeps per-file byte offsets plus the hourly
aggregates, so each run parses only new bytes but still sends the full 90-day snapshot. Rows older
than 7 days are rolled up to daily rows. Because the aggregates live in the state file, usage stays
counted even after Claude Code deletes old session logs. `--reset` rebuilds from the logs that still
exist, so avoid it unless the state is corrupt.

State from an older collector is fixed in place on the first run of a newer one (for example, one
re-read of the Claude logs to pick up missed output tokens), so updating never needs `--reset`.

A machine that was off catches up on its next run. A failed post retries with backoff and exits
non-zero; the token is never logged. A token with a space, a control character or anything else an
HTTP header cannot carry fails at once, without a retry, in both the collector and `push`.

## Coming from the earlier standalone script

`big-spender install` migrates an install of the earlier `usage-collector` script in place: it
removes the old systemd units or LaunchAgent, moves its config and state (so history is kept byte
for byte), renames the `USAGE_*` keys in the env file to `BIG_SPENDER_*`, and deletes the old copy
of the script. If `status` or `push` already made a new cache, the old state replaces it only while
the old collector is still scheduled or wrote its state last; otherwise the old cache is left in
place and the newer one kept. If the old collector, or a `status` or `push` whose cache would be
replaced, is running at that moment, install changes nothing and asks you to run it again. The
collector still reads `USAGE_DEVICE_ID`, `USAGE_INGEST_URL` and `USAGE_INGEST_TOKEN` when the
`BIG_SPENDER_*` name is unset, so a machine you have not updated keeps working.

## Development

```sh
npm install
npm run build     # tsc, then copies the collector into dist/
npm run check     # type check
npm test          # node:test; needs Node 22.18 or newer, which runs the TypeScript directly
```

The tests never call `systemctl` or `launchctl` and never touch your real config or cache:
`BIG_SPENDER_SCHEDULER=none` turns scheduler calls into no-ops, and each test runs in a throwaway
`HOME`.

## License

MIT
