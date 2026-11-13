# Deploy Dashboard Integration Tracker

This document tracks the integration between:

- `/Users/kevin.ke.wang/log-viewer`
- `/Users/kevin.ke.wang/dev/deploy-dashboard`

It is intentionally kept in the repository so work can continue safely across
long sessions and context compaction.

## Goal

Replace deploy-dashboard's browser-side `<pre>` Kubernetes log stream with the
log-viewer embedded viewer while keeping log-viewer independently runnable as
a standalone application.

The dashboard remains responsible for authentication, Kubernetes allow-listing,
and `kubectl logs`. log-viewer remains Kubernetes-agnostic and accepts generic
streamed log lines.

## Chosen topology

```text
browser -> deploy-dashboard:46777 -> authenticated /log-viewer/* proxy
                                      -> log-viewer:5178

deploy-dashboard LogSessionManager -> kubectl logs -f
                                  \-> log-viewer stream ingestion API
```

- log-viewer runs as a separate container.
- GitHub Actions builds and publishes it to `ghcr.io/kevinwang15/log-viewer`;
  production hosts pull the image rather than building it locally.
- Its host port is published on loopback only.
- The browser never connects to the private port directly.
- deploy-dashboard authenticates all proxied HTTP and WebSocket traffic.
- Log streams use random channel IDs and are deleted when their dashboard
  session ends.

## Integration contract

### Dashboard browser API

- `POST /api/log-sessions`
  - body: `appId`, `deploymentName`, `podName`, `container`, optional `tail`
  - validates the configured deployment and pod/container
  - creates a random log-viewer channel
  - starts `kubectl logs --tail=<n> -f`
  - returns `sessionId` and a same-origin `viewerUrl`
- `DELETE /api/log-sessions/:id`
  - terminates `kubectl`
  - deletes the log-viewer source

### log-viewer service API used by the dashboard

- `GET /api/v1/capabilities` for compatibility and limit discovery
- `PUT /api/v1/streams/:channel` with `x-stream-key`
- `POST /api/v1/streams/:channel/entries` with `x-stream-key`
- `DELETE /api/v1/streams/:channel` with `x-stream-key`
- embedded UI under `/embed.html?channel=<channel>&server=<proxy-base>`

The dashboard never constructs log-viewer's internal source ID. The legacy
stream routes remain temporarily available only for compatibility.

## Work checklist

### log-viewer

- [x] Make built frontend assets work below a URL prefix.
- [x] Make REST and WebSocket base URLs work with a relative proxy base.
- [x] Add switches to disable demo and sample traffic in integration deployments.
- [x] Add bounded entry-count stream retention.
- [x] Add a container health check and document loopback-only publishing.
- [x] Keep standalone root-path behavior working.
- [x] Add the established GHCR Buildx workflow and deployment tags.
- [x] Make the integration Compose definition pull the published image.
- [x] Add entry-, byte-, source-count-, request-, and idle-age limits.
- [x] Add a versioned, side-effect-free stream lifecycle API.
- [x] Bound the browser page cache and invalidate continuation-only changes.
- [x] Run the production image as a non-root user with production dependencies.

### deploy-dashboard

- [x] Add `logViewer` configuration and validation.
- [x] Add authenticated HTTP proxying under `/log-viewer/`.
- [x] Add authenticated WebSocket proxying under `/log-viewer/ws`.
- [x] Add an in-process log session manager with cleanup and timeout.
- [x] Batch complete lines from `kubectl` into log-viewer ingestion.
- [x] Replace `<pre id="logsOutput">` with the embedded iframe.
- [x] Preserve Stop/Reconnect and route-change cleanup.
- [x] Add container configuration and run instructions.
- [x] Negotiate API v1 and stop depending on internal source IDs.
- [x] Apply byte-aware batching and `kubectl` stdout backpressure.

### Verification

- [x] log-viewer unit tests and production build pass.
- [x] deploy-dashboard syntax check passes.
- [x] log-viewer container builds and becomes healthy.
- [x] Authenticated proxy serves embed assets and upgrades WebSockets.
- [x] A simulated producer is visible through the proxied API used by the embedded viewer.
- [x] A push to `main` publishes the GHCR image successfully.
- [x] A real Kubernetes pod log session works where kubeconfig is available.

## Follow-ups after MVP

- Replace the deployment-wide stream key with per-producer credentials if
  log-viewer is ever shared across trust boundaries.
- Add opaque, source-scoped view capabilities for cross-origin embedding.
- Add optional disk-backed stream spooling for retention beyond memory limits.
- Add deployment-level merged views across multiple pods.

## Progress log

- 2026-07-13: inspected both repositories and selected the separate-container,
  authenticated same-origin proxy design.
- 2026-07-13: implemented the MVP in both repositories. Built and ran the
  log-viewer image with nerdctl, then passed an automated end-to-end test using
  an authenticated dashboard, fake kubectl process, HTTP/WebSocket proxy, and
  embedded-viewer API.
- 2026-07-13: validated `compose.integration.yaml` with nerdctl Compose on a
  loopback-only port and confirmed the container health endpoint before cleaning
  up the test project.
- 2026-07-13: changed image delivery to GitHub Actions and GHCR, matching the
  existing short-SHA, full-SHA, branch, and `latest` tagging convention. The
  production Compose file now pulls the published image. Parsed the workflow
  and rebuilt its named `production` target locally with nerdctl before the
  first push.
- 2026-07-13: pushed the integration directly to `main`; GitHub Actions run
  `29221799738` passed and published the image. A local arm64 pull then exposed
  an amd64-only manifest, so the workflow was updated to publish both
  `linux/amd64` and `linux/arm64` images.
- 2026-07-13: deployed the integration on `103.120.91.122` and verified a real
  `icdesign-backend` Kubernetes log session through the authenticated iframe,
  HTTP proxy, WebSocket proxy, and cleanup path. Confirmed port 5178 refuses
  public connections and is reachable only through loopback/ClusterIP paths.
- 2026-07-13: hardened the contract with API v1, bounded stream/source/browser
  memory, idle cleanup, payload limits, byte-aware producer backpressure,
  reconnect snapshots, a non-root runtime image, black-box API tests, and
  dedicated API/embedding/operations documentation.
