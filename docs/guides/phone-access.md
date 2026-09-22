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

The address is saved next to the token (`archcar.listen` in the state
directory), not only inside the service definition, so **every** daemon on the
machine serves it — including the one the desktop app spawns for itself. That
matters because only one daemon can hold the local socket: whichever starts
first wins, and before the address was saved outside the unit, remote access
worked only when the installed service happened to win that race.

A daemon binds the port once, at startup. So a daemon that was already running
when you installed the service keeps serving nothing until it exits: **quit and
reopen the desktop app** after enabling phone access. `service install` says so
in a warning when it detects that case.

## Pair the phone

1. Desktop app → Settings → **Pair a phone** → **Show pairing code**. The card
   says up front whether this machine is reachable, and what to fix if not. The
   code opens in its own window because it carries a live token.
2. In the iOS app: More → Pair a daemon → Scan pairing code.
3. Hide the code once the phone has paired. It contains a live token, so it is
   worth treating like a password on screen.

No desktop nearby? Use **Or enter it by hand** with the address from
`archductor service status` and the token from `archductor service token`. A
non-loopback address makes the app ask you to confirm you understand the token
is sent in the clear.

## Turn phone access off

```sh
archductor service uninstall            # remove the service entirely
archductor service install              # keep the service, drop the listener
```

Either clears the saved address, so the next daemon binds no TCP port. The
daemon running right now already owns the port and keeps answering on it until
it exits — the command warns when that is the case. Quit and reopen the desktop
app (or stop the daemon) to actually close the port, and rotate the token if
the point was to lock someone out.

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
