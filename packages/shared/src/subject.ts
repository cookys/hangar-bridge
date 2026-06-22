// Single source of truth for subject namespace ownership + interest matching.
// Used by the relay (live fanout + backlog) AND the peer-agent pre-context
// filter, so there is exactly ONE matcher and no JS/SQL parity gap (the relay
// fetches backlog rows by handle then filters them in JS with these functions).

/** The namespace of a subject = its first dot-token (whole string if no dot). */
export function namespaceOf(subject: string): string {
  const i = subject.indexOf('.')
  return i === -1 ? subject : subject.slice(0, i)
}

/**
 * OWNERSHIP GATE (fail-closed): exact namespace equality against the owned set.
 * No wildcards. A namespace with no owner ⇒ ownsNamespace is false for everyone.
 */
export function ownsNamespace(subject: string, ownedSet: ReadonlySet<string>): boolean {
  return ownedSet.has(namespaceOf(subject))
}

/**
 * INTEREST FILTER (narrow-only): exact subject equality OR a trailing-'>' prefix.
 * `mple2.status>` (and `mple2.status.>`) match `mple2.status` and `mple2.status.*`.
 * '>' is the only wildcard and only valid as a trailing token.
 */
export function matchesInterest(subject: string, interest: readonly string[]): boolean {
  for (const pat of interest) {
    if (pat.endsWith('>')) {
      const base = pat.slice(0, -1).replace(/\.$/, '')
      if (subject === base || subject.startsWith(base + '.')) return true
    } else if (subject === pat) {
      return true
    }
  }
  return false
}
