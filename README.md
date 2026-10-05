# chino-tizen

Samsung TV (Tizen) client for **chino**, the video app of the
[zaentrum](https://github.com/zaentrum/zaentrum) self-hosted media platform.

It is a **bring-your-own-server** client: on first launch you point it at your
own zaentrum server (the Add-Server flow), and it discovers everything else —
the API base from `GET /api/config` and the sign-in endpoints via OIDC
discovery against your issuer. No server address is baked into the build.

It follows **chino-web**, the reference client, for UI and streaming logic
(ported, not shared code), and adds the Tizen-specific layer: a native
**AVPlay** player (with an hls.js fallback), a D-pad **spatial focus** engine,
**device-flow** auth, and `.wgt` packaging.

## Connecting to a server

1. Launch the app and enter your server's address (e.g. `https://media.example.com`).
2. The client probes the server, reads `GET /api/config` for the OIDC issuer and
   the public client id, and runs OIDC discovery for the device-authorization +
   token endpoints.
3. Sign in with the on-screen device code on a second screen.

You can change servers later from **Settings → Change server**, and
**Settings → Delete Account** deletes your account on the server (after
asking) and signs it out on the TV.

Sign-in uses the OAuth 2.0 Device Authorization Grant (RFC 8628). Register a
public client for the TV in your OIDC issuer's clients (a device-flow-capable
client whose id your server advertises in `GET /api/config`).

## Addons

Addons installed on your server reach the app through two generic seams, so
the app never needs to know them:

- **Buttons** under a search that finds nothing (the `search.empty` slot). A
  button that runs an action sends it from the TV; one that opens a page
  shows its address instead, to open on a phone or computer.
- **Notices** — what an addon tells you. The bell in the top bar counts the
  unread ones; open it to read them, open the title one is about, mark them
  all read, or delete them. A TV shows a notice's text only, not its link.

With no addons, or no portal on the server, neither shows anything.

## Develop (desktop browser)

```sh
npm install
npm run dev      # Tizen Web Device APIs are no-ops off-device
npm run build    # tsc --noEmit + Vite build → dist/
```

## Package & run (.wgt) — requires Tizen Studio CLI

```sh
tizen build-web -- dist
tizen package -t wgt -s <security-profile> -- .buildResult
tizen install  -n Chino.wgt -t <emulator|device>
```

Target: Samsung Tizen **4.0+ (2018+)**. Emulator-first via Tizen Studio; real-device
verification needs a Samsung author + distributor certificate.

## License

[MPL-2.0](LICENSE).
