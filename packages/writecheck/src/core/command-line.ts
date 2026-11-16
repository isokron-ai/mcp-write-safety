/** A command line or URL as printed in results and reports, with every credential left out (R10-9; review S6). */

/** A command line with every credential left out: the value of a flag whose name says token, key, secret, password, auth or credential, and any argument that looks like a token. */
export function safeCommand(argv: string[]): string {
  const cred = /(token|key|secret|pass(word)?|auth|cred(ential)?s?|bearer|cookie|session)/i;
  // why: review: a scheme-tagged token anywhere in an argument, and a credential-named key in JSON, are left out wherever they are.
  // why: review (twice): a credential anywhere in an argument is left out, including inside an `sh -c` string: a flag that names
  // one (--api-key=S, --password S), NAME=value (export GITHUB_TOKEN=S, a=1&password=S), a URL's user information, a
  // scheme-tagged token, and a credential-named key in JSON or YAML-like text (quoted or not, its value whole, one level deep).
  const C = String.raw`[\w-]*(?:token|key|secret|pass(?:word|wd)?|auth\w*|cred\w*|bearer|cookie|session)[\w-]*`;
  const scrub = (a: string): string =>
    a
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\/\s:@]+:[^\/\s@]+@/gi, '$1(left out)@')
      .replace(/\b(Bearer|Basic|Token|Digest)\s+[^\s"',;]+/gi, '$1 (left out)')
      .replace(new RegExp(String.raw`((?:^|\s)--?${C})(=|\s+)(?!-)("[^"]*"|'[^']*'|\S+)`, 'gi'), '$1$2(left out)')
      .replace(new RegExp(String.raw`(\b${C})=([^\s&;]+)`, 'gi'), '$1=(left out)')
      .replace(new RegExp(String.raw`(["']?${C}["']?\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{[^{}]*\}|\[[^\[\]]*\]|[^,}\s]+)`, 'gi'), '$1"(left out)"');
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = /^(--?[^=\s]+)=(.*)$/.exec(a);
    // why: review (11, and again): a header value is left out whole, whatever its form (-H "Authorization: Bearer …", -H X-Api-Key=…, --headers '{…}').
    if (/^(-H|--headers?)$/.test(a) && i + 1 < argv.length) {
      const v = argv[i + 1]!;
      const name = /^([A-Za-z0-9_-]+)\s*[:=]/.exec(v)?.[1];
      out.push(a, name ? `${name}: (left out)` : '(left out)');
      i++;
    } else if (/^(-H|--headers?)=/.test(a)) out.push(`${a.split('=')[0]}=(left out)`);
    else if (/^-H./.test(a)) out.push('-H (left out)');
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && cred.test(a.split('=')[0]!)) out.push(`${a.split('=')[0]}=(left out)`);
    else if (eq && cred.test(eq[1]!)) out.push(`${eq[1]}=(left out)`);
    // why: review S6: a single-letter flag (-k sk_live_..., -p hunter2hunter2) says nothing by its name; its value is left out
    // unless it is plainly not a secret (a number, a path, or a plain word).
    else if (/^-[A-Za-z]$/.test(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith('-') && !/^(\d+|[A-Za-z]+(-[A-Za-z]+)*|[.~]?\/.*|[A-Za-z]:\\.*)$/.test(argv[i + 1]!)) {
      out.push(a, '(left out)');
      i++;
    } else if (/^--?[\w-]+$/.test(a) && cred.test(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
      out.push(a, '(left out)');
      i++;
    } else if (/^[A-Za-z0-9_\-.+/=]{24,}$/.test(a) && /[0-9]/.test(a) && /[A-Za-z]/.test(a) && !a.includes('/')) out.push('(left out)');
    else out.push(scrub(stripUrlSecrets(a)));
  }
  return out.join(' ');
}

/** A URL without its user information and without query values of credential-like parameters. */
export function stripUrlSecrets(s: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) if (/(token|key|secret|pass|auth|sig|cred)/i.test(k)) u.searchParams.set(k, '(left out)');
    // a path segment that looks like a token (long, letters and digits mixed)
    u.pathname = u.pathname.split('/').map((seg) => (seg.length >= 20 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) ? '(left out)' : seg)).join('/');
    return u.toString();
  } catch {
    return s;
  }
}
