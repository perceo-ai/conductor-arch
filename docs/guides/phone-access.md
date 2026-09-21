# Reach Archductor from your phone

The iOS app in `ios/` is a client of an archcar daemon, the same way the desktop
app is. It lists your workspaces with live status; driving agents, reviewing
changes, and notifications arrive in later phases.

## Before you start

The daemon must listen on an address your phone can reach, and the token it
hands out travels **unencrypted**. Anyone who can reach that port and holds the
token can run commands on that machine, read the repository, and push branches.

Only do this over Tailscale, WireGuard, or a LAN you trust.

## Enable phone access

Install the background service with a listen address:

```sh
archductor service install --listen 0.0.0.0:7420
archductor service status
```

`status` reports the address the daemon is serving. If you run `archcar` by
hand instead, set `ARCHDUCTOR_ARCHCAR_LISTEN=0.0.0.0:7420` in its environment.

## Pair the phone

1. Desktop app → Settings → Clients → **Show pairing code**.
2. In the iOS app: More → Pair a daemon → Scan pairing code.
3. Hide the code once the phone has paired. It contains a live token, so it is
   worth treating like a password on screen.

No desktop nearby? Use **Or enter it by hand** with the address from
`archductor service status` and the token from `archductor service token`. A
non-loopback address makes the app ask you to confirm you understand the token
is sent in the clear.

## Revoke a phone

```sh
archductor service token --rotate
```

That invalidates every paired client at once, including the desktop, so pair
them again afterwards.

## Building the app

The app is not distributed yet. To run it yourself:

```sh
brew install xcodegen
cd ios && xcodegen generate
open Archductor.xcodeproj
```

`make ios-test` runs the logic tests, including a suite that boots a real
`archcar` and round-trips the protocol against it.
