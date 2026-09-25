# Local HTTP API

`launch.py` exposes a small JSON API scoped to the workspace folder. It exists
so the browser can read and write real files; it is bound to `127.0.0.1` and has
no authentication because it is not meant to leave your machine.

Every response is JSON with an `ok` boolean. Errors return
`{"ok": false, "error": "…"}` with a 4xx/5xx status.

All `path` values are **workspace-relative** (`templates/foo.json`,
`assets/icons/fire.svg`). Anything that resolves outside the workspace is
rejected, and so is the workspace folder itself — only `GET /api/list` accepts
`.` for the top level.

**Who may call it.** A request carrying an `Origin` header that does not match
the host it was sent to is refused with `403`, as is one whose `Host` names
something this server does not answer to. Requests with no `Origin` at all —
curl, CI, a script — are unaffected. This is what stops a web page you happen to
have open from rewriting your workspace over loopback; there is no
`Access-Control-Allow-Origin` anywhere. A refused request closes its connection.

Bodies must carry a `Content-Length`; chunked bodies are refused.

## Static routes

| Route | Purpose |
| --- | --- |
| `GET /` | the editor (`web/index.html`) |
| `GET /js/…`, `/css/…`, `/vendor/…` | front-end files |
| `GET /files/<workspace path>` | raw asset bytes (images, fonts) |

## GET endpoints

### `GET /api/status`

```json
{ "ok": true, "app": "TCG Forge", "version": "0.1.0",
  "workspace": "/home/you/tcgforge/workspace",
  "categories": ["frames","backgrounds","icons","art","textures","fonts"],
  "python": "3.11.9", "time": "2026-01-01T00:00:00+00:00" }
```

The front end calls this once at startup to decide whether it is online.

### `GET /api/assets`

Walks `workspace/assets/*` recursively and returns every usable file grouped by
category. Images are `.png .jpg .jpeg .webp .gif .svg .avif .bmp`; fonts are
`.ttf .otf .woff .woff2`.

```json
{ "ok": true, "assets": { "icons": [
  { "name": "element-fire", "file": "element-fire.svg", "ext": "svg",
    "path": "assets/icons/element-fire.svg",
    "url": "/files/assets/icons/element-fire.svg",
    "group": "", "size": 214, "modified": "2026-01-01T00:00:00+00:00" }
] } }
```

`group` is the subfolder the file was found in, so you can organise assets into
sets.

### `GET /api/templates` · `GET /api/projects`

List the JSON files in `workspace/templates` / `workspace/projects`, with each
file's `id`, `name`, `description`, `tags`, `card` and field count read from
inside. `id` is the slug a project's `templateId` refers to, which need not be
the slug of the display name (`classic-spell` vs "Classic Spell Frame").
Corrupt files are still listed, with an `error` key.

### `GET /api/read?path=…`

Returns `{ "ok": true, "path": "…", "content": "<file text>" }`.

### `GET /api/list?path=…`

Directory listing: `name`, `path`, `dir`, `size`, `modified`.

## POST endpoints

All take a JSON body.

### `POST /api/write`

```json
{ "path": "projects/my-card.json", "content": "{…}", "backup": true }
```

Writes atomically (temp file + rename); a write that fails leaves no temp file
behind, and a path naming a folder is refused. With `backup: true` an existing
file is copied to `<name>.bak` first. Returns the path and byte count.

### `POST /api/upload`

```json
{ "category": "icons", "filename": "fire.png",
  "group": "my-set", "data": "data:image/png;base64,…" }
```

Copies a file into `assets/<category>[/<group>]`. Names are sanitised and
de-duplicated (`fire-2.png`), and the payload is capped at 64 MB. Returns the
new `path` and `url`.

### `POST /api/export`

```json
{ "filename": "ember-wyrm.png", "data": "data:image/png;base64,…",
  "folder": "core-set", "overwrite": true }
```

Writes into `workspace/exports` and returns both the relative path and the
absolute one, so the UI can tell you where the file landed.

`folder` puts the file in a subfolder of `exports/` (used by batch runs to keep
a set together). `overwrite` replaces an existing file instead of writing
`name-2.png`; batch runs set it so re-rendering a set replaces it, single
exports leave it off.

### `POST /api/mkdir`

`{ "path": "assets/icons/my-set" }`

### `POST /api/trash`

`{ "path": "templates/old.json" }` — moves the file to
`workspace/.trash/<YYYYMMDD>/`. Nothing is hard-deleted.

### `POST /api/shutdown`

Stops the server. Handy for wrapper scripts.

## Using it from a script

The API is plain HTTP, so batch jobs need nothing more than `curl` or
`requests`:

```bash
# render every project in the workspace via the browser? not needed —
# just read and rewrite the JSON directly:
curl -s "http://127.0.0.1:7870/api/read?path=projects/my-card.json" \
  | python -c "import json,sys; print(json.load(sys.stdin)['content'][:200])"
```

For canvas work that needs Fabric (rendering, batch text replacement), drive the
page instead — `window.TCGForge` exposes the editor, and
`tools/build_templates.mjs` is a worked example.
