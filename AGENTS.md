# chino-tizen

chino's app for Samsung TVs with Tizen 4.0 and later: a React and TypeScript
web app, built with Vite and packaged as a Tizen `.wgt`. It follows
chino-web's screens and rules, ported rather than shared, and adds what a TV
needs: Samsung's AVPlay player (hls.js where AVPlay is missing), a focus engine
for the remote's D-pad (`src/tv/`) and sign-in by a device code (RFC 8628). The
app carries no server address: the person adds one on the TV, and the app
talks to that server's chino-api under `/api/` and signs in with the OpenID
Connect issuer the server names.
How a change is proposed and what a pull request has to pass is in the
[guide to contributing](https://github.com/zaentrum/.github/blob/main/CONTRIBUTING.md);
what may be built is in [building from the specification](https://github.com/zaentrum/zaentrum/blob/main/AGENTS.md).

## Build

```sh
npm ci
npm run build    # tsc --noEmit, then vite build into dist/
```

The workflow's `build` job builds with Node 24, and `package-wgt` runs `npm ci`
and the build on Node 20; `package.json` names no engine. The bundle
targets ES2018, for the oldest TVs the app supports. The `.wgt` needs the
Tizen Studio CLI (`tizen`) on the PATH and a security profile with an author
and a distributor certificate:

```sh
TIZEN_PROFILE=<profile> bash tools/package-wgt.sh   # npm run build, then .buildResult/Chino.wgt
```

The workflow's `package-wgt` job runs it through `tools/ci-package-wgt.sh`,
which installs the CLI and writes the profile, on a push to `main` and only
with an author certificate and its password held as repository secrets.

## Test

```sh
npm test         # node --test src/lib/*.test.ts
```

`.github/workflows/ci.yml` runs `npm ci`, `npm test` and `npm run build` on
every pull request and on `main` (job `build`), beside its `neutrality` job.
Node runs the TypeScript itself, which takes Node 22.18 or later. The tests
cover the modules in `src/lib/` and need no TV and no server: those that ask
chino-api are handed a fake `fetch`, and `caps.test.ts` fakes what the TV
reports about itself.

## Run it

In a desktop browser, `npm run dev` serves the app on `http://localhost:5173`.
The TV's APIs are missing there: the player is hls.js, and the arrow keys and
Enter stand in for the remote; its Back key has no counterpart on the keyboard.
Add Server goes no further than its first request: chino-api answers
`/api/healthz` without a CORS header, so the browser withholds the answer and
the app says it couldn't reach the server. Sign-in and playback take the
emulator or a TV.

Install the package on the Tizen Studio TV emulator, or on a Samsung TV in
developer mode (in Apps, 1 2 3 4 5 on the remote, with the development
machine's address) connected with `sdb connect <tv-address>`. A TV takes a
package signed with a Samsung author and distributor certificate.

```sh
cd .buildResult && tizen install -n Chino.wgt -t <target>
```

On first launch the TV asks for the server's address, typed on its on-screen
keyboard: the reference demo
([how it is deployed](https://github.com/zaentrum/zaentrum/blob/main/docs/reference-demo.md))
or your own instance, such as `https://media.example.org`; without a scheme it
tries https, then http. The app reads `/api/healthz` and `/api/config`,
discovers the issuer that `/api/config` names, and needs its device
authorization endpoint. It signs in as the client that `/api/config` gives as
`oidcClientId.tv` (`chino` where it gives none): the TV shows a code and a
link, and the person confirms on a phone or a computer. There is no harness of
recorded answers to run the app against.

## What the tests leave unchecked

- Everything outside `src/lib/`: the screens, the focus engine (`src/tv/`), the
  players (`src/player/`), the address probe and the device-code sign-in
  (`src/auth/`), the API client (`src/api/`), the stores (`src/state/`) and the
  bug reporter (`src/feedback/`).
- Nothing runs on a TV or the emulator: AVPlay, the TV's decoders and its
  `webapis` are never asked.
- The test files are not type-checked: `tsconfig.json` leaves them out of
  `npm run build`, and Node only strips their types.
- The `.wgt` and its signing: only on a push to `main` with the certificate
  secrets.

## Before a pull request

The workflow's `neutrality` job fails on an internal hostname, another media
product's name or acquisition words anywhere in the tree but `node_modules`,
`dist`, `.github`, `package-lock.json` and `LICENSE`, this file included. Its
patterns are in `.github/workflows/ci.yml`; there is no script that runs them
locally.
