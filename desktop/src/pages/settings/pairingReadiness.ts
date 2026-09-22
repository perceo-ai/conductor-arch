// Can a phone actually pair with this daemon right now?
//
// Main answers the same question authoritatively when it builds the QR (see
// electron/pairing.ts) — but only once the button is pressed, which is how the
// card used to dead-end on an error. This mirrors the rules so the card can say
// what is missing before anyone clicks, and name the fix.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type PairingReadiness =
  | { ready: true; address: string }
  | { ready: false; reason: string; fix?: string };

/// `access.listen` is what the daemon answering right now actually bound;
/// `configuredListen` is what remote access was set up to serve. They differ
/// for exactly as long as it takes to restart a daemon that started before
/// the address was saved, and saying so beats sending someone back to reinstall
/// a service that is already installed.
export function pairingReadiness(
  access: { listen: string | null | undefined; token: string } | null,
  configuredListen?: string | null,
): PairingReadiness {
  if (!access) {
    return { ready: false, reason: "Could not read this daemon's remote access settings." };
  }
  if (!access.listen) {
    return configuredListen
      ? {
          ready: false,
          reason: `Remote access is set up for ${configuredListen}, but the daemon running now started before that and is not serving it.`,
          fix: "Quit and reopen Archductor; the listener comes up with the daemon that replaces it.",
        }
      : {
          ready: false,
          reason: "This daemon has no remote listener, so a phone has nothing to connect to.",
          fix: "Install the background service above with a listen address like 0.0.0.0:7420.",
        };
  }
  const parts = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(access.listen.trim());
  if (!parts) {
    return { ready: false, reason: `Could not read the listen address "${access.listen}".` };
  }
  if (LOOPBACK_HOSTS.has(parts[1])) {
    return {
      ready: false,
      reason: `This daemon listens on ${access.listen}, which only this machine can reach.`,
      fix: "Reinstall the background service above with 0.0.0.0:7420 to accept phones on your network.",
    };
  }
  if (!access.token) {
    return {
      ready: false,
      reason: "This daemon has no access token yet.",
      fix: "Install the background service above to create one.",
    };
  }
  return { ready: true, address: access.listen };
}
