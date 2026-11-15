// Is this failure about the code, or about the machine and services it ran on? In the
// benchmarks about a third of failures were infrastructure: DNS, 5xx from a registry, a missing
// artifact, a runner timeout, a used-up quota, a rejected token. Most want a re-run, not a fix;
// a rejected token wants someone to update the secret.

export interface InfraHint {
  /** What kind of trouble, in a few words. */
  kind: string;
  /** What to do about it. */
  advice: string;
  /** The line that says so. */
  line: string;
}

const RERUN = 'Re-running the job usually fixes it.';
const SECRET = 'Re-running won’t help: check the token or secret the job uses.';

const INFRA: [RegExp, string, string][] = [
  [
    /\b(?:ENOTFOUND|EAI_AGAIN|Could not resolve host|Temporary failure in name resolution|getaddrinfo|nodename nor servname provided|Name or service not known|No such host is known)\b/i,
    'DNS lookup failed',
    RERUN,
  ],
  [
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection reset by peer|Connection aborted|RemoteDisconnected|Connection timed out|TLS handshake timeout|socket hang up|unexpected EOF|Remote end closed connection)\b/i,
    'a network connection failed',
    RERUN,
  ],
  [
    /\b(?:50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)|Unexpected HTTP response: 5\d\d|HTTP (?:error |status )?5\d\d|status code 5\d\d)\b/i,
    'a server returned 5xx',
    RERUN,
  ],
  [
    /\b(?:API )?rate limit (?:exceeded|reached)|\b429 Too Many Requests\b|secondary rate limit/i,
    'rate limited',
    RERUN,
  ],
  [
    /\b401 Unauthorized\b|\b(?:token|credentials?) (?:is |are )?(?:invalid|expired|revoked)\b|Bad credentials|authentication (?:failed|required)/i,
    'credentials were rejected',
    SECRET,
  ],
  [
    /\bout of (?:AI )?usage\b|\bquota (?:exceeded|exhausted)\b|insufficient_quota|billing (?:limit|issue)/i,
    'a usage quota ran out',
    'Re-running won’t help until the quota resets or is raised.',
  ],
  [
    /No space left on device|ENOSPC/i,
    'the runner ran out of disk',
    'Free up disk space in the job, or use a bigger runner.',
  ],
  [
    /Artifact not found for name|Failed to CreateArtifact|Unable to download artifact/i,
    'an artifact was missing or could not be uploaded',
    RERUN,
  ],
  [
    /\bhas timed out after \d+ minutes?|The action has timed out|has exceeded the maximum execution time|The operation was canceled/i,
    'the job hit its time limit or was cancelled',
    'Re-run it; if it keeps happening, something got slower or hangs.',
  ],
  [
    /lost communication with the server|runner has received a shutdown signal|Failed to download action/i,
    'the runner or GitHub had a problem',
    RERUN,
  ],
];

export function infraHint(lines: string[]): InfraHint | undefined {
  for (const line of lines) {
    for (const [rx, kind, advice] of INFRA)
      if (rx.test(line)) return { kind, advice, line: line.trim() };
  }
  return undefined;
}
