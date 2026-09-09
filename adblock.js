// ---------- The ad blocker ----------
//
// Aurora's tracker blocking is a hand-written list of about forty hosts.
// This is the other thing: EasyList and EasyPrivacy, the same public filter
// lists uBlock and AdBlock Plus use, which between them are tens of
// thousands of rules kept up to date by other people.
//
// Why this lives in the browser rather than in an extension: Electron
// ignores the static rulesets an extension declares in its manifest, which
// is exactly how ad blockers ship their filters, so a real one cannot work
// as an extension here. Aurora already filters every request in
// onBeforeRequest, so the lists go there instead.
//
// The whole design constraint is speed. This runs on every single request,
// and a browser that got visibly slower would not be worth an ad blocker.
// Testing forty thousand regexes per request is not an option, so each rule
// is filed under a substring that must appear in the URL for it to have any
// chance of matching, and a request only tests the buckets its own URL
// implicates.

// Filters describe request types with their own names, not Electron's.
const TYPE_MAP = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'other',
  media: 'media',
  webSocket: 'websocket',
  other: 'other'
};

const KNOWN_TYPES = new Set([
  'document', 'subdocument', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'
]);

// Options that change what a rule matches but that this engine does not
// implement. A rule carrying one is dropped rather than applied without it:
// a filter enforced more broadly than its author intended breaks pages.
const UNSUPPORTED_OPTIONS = new Set([
  'popup', 'popunder', 'elemhide', 'generichide', 'genericblock', 'csp',
  'redirect', 'redirect-rule', 'removeparam', 'replace', 'inline-script',
  'inline-font', 'empty', 'mp4', 'cname', 'urltransform', 'permissions',
  'header', 'method', 'to', 'from', 'denyallow', 'strict1p', 'strict3p',
  'important', 'badfilter', 'all', 'object-subrequest', 'webrtc'
]);

// Multi-part public suffixes, enough to get "is this a third party" right
// where it usually matters. A full public suffix list would be more correct;
// this is the part of it that fits in a few lines.
const MULTI_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz', 'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'co.za', 'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw',
  'co.kr', 'com.pl', 'com.ua', 'co.il', 'com.es', 'com.pt'
]);

function hostOf(url) {
  // The (?:...@)? skips any user:pass@ before the host -- the same guard the
  // tracker blocklist needs, for the same reason.
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*@)?([^/:?#]+)/i.exec(url || '');
  return m ? m[1].toLowerCase() : '';
}

function registrableDomain(host) {
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

// ---------- Turning one filter line into something matchable ----------

function escapeForRegex(text) {
  return text.replace(/[.+?${}()|[\]\\]/g, '\\$&');
}

// Adblock pattern syntax into a regular expression.
//   ||host   the address's host, or any subdomain of it
//   ^        a separator: anything that is not part of a name
//   *        anything
//   |        the very start or the very end of the address
function patternToRegex(pattern) {
  let source = '';
  let rest = pattern;

  if (rest.startsWith('||')) {
    // Scheme, optional userinfo, optional subdomains, then the name given.
    source += '^[a-z][a-z0-9+.-]*://(?:[^/?#]*@)?(?:[^/?#]*\\.)?';
    rest = rest.slice(2);
  } else if (rest.startsWith('|')) {
    source += '^';
    rest = rest.slice(1);
  }

  let end = '';
  if (rest.endsWith('|')) {
    end = '$';
    rest = rest.slice(0, -1);
  }

  for (const ch of rest) {
    if (ch === '*') source += '.*';
    else if (ch === '^') source += '(?:[^\\w\\-.%]|$)';
    else source += escapeForRegex(ch);
  }

  return source + end;
}

// The bucket key. A rule can only match a URL containing this substring, so
// a request without it never tests the rule at all. The longest token is
// chosen because long ones are rare, which keeps buckets small.
const TOKEN_RE = /[a-z0-9%]{3,}/g;

function tokensOf(text) {
  return String(text).toLowerCase().match(TOKEN_RE) || [];
}

function bestToken(pattern) {
  // Anything after a wildcard is not guaranteed to appear in that form, so
  // only look before the first one.
  const usable = pattern.split('*')[0];
  const tokens = tokensOf(usable);
  if (!tokens.length) return null;
  let best = tokens[0];
  for (const token of tokens) if (token.length > best.length) best = token;
  return best;
}

function parseRule(line) {
  let text = line.trim();
  if (!text) return null;
  if (text.startsWith('!') || text.startsWith('[')) return null;

  const rule = {
    exception: false,
    types: null,
    excludedTypes: null,
    thirdParty: null,
    domains: null,
    excludedDomains: null,
    matchCase: false
  };

  if (text.startsWith('@@')) {
    rule.exception = true;
    text = text.slice(2);
  }

  // Options live after the last unescaped $, but a regex rule may contain
  // one, so only split when the rule is not a bare regex.
  let pattern = text;
  let options = '';
  const isRegex = text.length > 2 && text.startsWith('/') && text.endsWith('/');
  if (!isRegex) {
    const dollar = text.lastIndexOf('$');
    if (dollar > 0) {
      pattern = text.slice(0, dollar);
      options = text.slice(dollar + 1);
    }
  }
  if (!pattern) return null;

  const optionList = options ? options.split(',') : [];
  for (const raw of optionList) {
    let option = raw.trim();
    if (!option) continue;

    let negated = false;
    if (option.startsWith('~')) {
      negated = true;
      option = option.slice(1);
    }

    const eq = option.indexOf('=');
    const name = (eq === -1 ? option : option.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : option.slice(eq + 1);

    if (name === 'third-party' || name === '3p') {
      rule.thirdParty = !negated;
    } else if (name === 'first-party' || name === '1p') {
      rule.thirdParty = negated;
    } else if (name === 'match-case') {
      rule.matchCase = true;
    } else if (name === 'domain') {
      const entries = value.split('|');
      for (const entry of entries) {
        const domain = entry.trim().toLowerCase();
        if (!domain) continue;
        if (domain.startsWith('~')) {
          if (!rule.excludedDomains) rule.excludedDomains = new Set();
          rule.excludedDomains.add(domain.slice(1));
        } else {
          if (!rule.domains) rule.domains = new Set();
          rule.domains.add(domain);
        }
      }
    } else if (name === 'xhr' || KNOWN_TYPES.has(name)) {
      const resolved = name === 'xhr' ? 'xmlhttprequest' : name;
      if (negated) {
        if (!rule.excludedTypes) rule.excludedTypes = new Set();
        rule.excludedTypes.add(resolved);
      } else {
        if (!rule.types) rule.types = new Set();
        rule.types.add(resolved);
      }
    } else {
      // Unsupported, or simply unknown. Either way the rule is dropped
      // rather than enforced with a meaning its author did not write.
      return null;
    }
  }

  // By far the most common shape is "||some.host^" -- the whole domain and
  // everything under it. That needs no regular expression: walking the
  // request's host up its own labels answers it exactly, and skipping the
  // regex for these saves most of the memory the lists would otherwise cost.
  const pureDomain = /^\|\|([a-z0-9][a-z0-9.\-]*[a-z0-9])\^?$/i.exec(pattern);
  if (pureDomain) {
    rule.domain = pureDomain[1].toLowerCase();
    rule.token = null;
    return rule;
  }

  let source;
  if (isRegex) {
    source = pattern.slice(1, -1);
    rule.token = null;   // nothing dependable to bucket on
  } else {
    source = patternToRegex(pattern);
    rule.token = bestToken(pattern);
  }

  try {
    rule.regex = new RegExp(source, rule.matchCase ? '' : 'i');
  } catch (err) {
    return null;   // a pattern this engine cannot express
  }
  return rule;
}

// ---------- The lists, and matching against them ----------

class Engine {
  constructor() {
    this.reset();
  }

  reset() {
    this.blockBuckets = new Map();
    this.blockAlways = [];
    this.blockDomains = new Map();
    this.allowBuckets = new Map();
    this.allowAlways = [];
    this.allowDomains = new Map();
    // domain -> [css selectors], for ads a page draws itself rather than
    // fetching. Only domain-specific rules are kept; the generic ones run to
    // tens of thousands of selectors and are not worth what they cost.
    this.cosmetic = new Map();
    this.ruleCount = 0;
    this.cosmeticCount = 0;
    this.hidingCache = new Map();
  }

  addRule(rule) {
    const buckets = rule.exception ? this.allowBuckets : this.blockBuckets;
    const always = rule.exception ? this.allowAlways : this.blockAlways;

    if (rule.domain) {
      const domains = rule.exception ? this.allowDomains : this.blockDomains;
      let list = domains.get(rule.domain);
      if (!list) {
        list = [];
        domains.set(rule.domain, list);
      }
      list.push(rule);
      this.ruleCount++;
      return;
    }

    if (rule.token) {
      let list = buckets.get(rule.token);
      if (!list) {
        list = [];
        buckets.set(rule.token, list);
      }
      list.push(rule);
    } else {
      always.push(rule);
    }
    this.ruleCount++;
  }

  addCosmetic(line) {
    const at = line.indexOf('##');
    if (at === -1) return;
    const domains = line.slice(0, at);
    const selector = line.slice(at + 2).trim();
    if (!selector || !domains) return;          // generic rules are skipped
    // Procedural selectors are a small language of their own, not CSS.
    if (/-abp-|:has\(|:matches-|:xpath|:style\(|:remove\(|:upward|:watch-attr/.test(selector)) return;

    const entries = domains.split(',');
    for (const entry of entries) {
      const domain = entry.trim().toLowerCase();
      if (!domain || domain.startsWith('~')) continue;
      let list = this.cosmetic.get(domain);
      if (!list) {
        list = [];
        this.cosmetic.set(domain, list);
      }
      if (list.length < 400) {
        list.push(selector);
        this.cosmeticCount++;
      }
    }
  }

  parseList(text) {
    const lines = String(text).split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('[')) continue;

      // Cosmetic rules and their exceptions are a different language.
      if (trimmed.includes('#@#') || trimmed.includes('#?#') || trimmed.includes('#$#')) continue;
      if (trimmed.includes('##')) {
        this.addCosmetic(trimmed);
        continue;
      }

      const rule = parseRule(trimmed);
      if (rule) this.addRule(rule);
    }
  }

  ruleApplies(rule, type, requestDomain, documentDomain, isThirdParty) {
    if (rule.types) {
      if (!rule.types.has(type)) return false;
    } else if (type === 'document') {
      // A filter with no type options never blocks a page you navigated to.
      // Without this the first ad rule to match would blank the whole tab.
      return false;
    }
    if (rule.excludedTypes && rule.excludedTypes.has(type)) return false;
    if (rule.thirdParty !== null && rule.thirdParty !== isThirdParty) return false;

    if (rule.domains || rule.excludedDomains) {
      const where = documentDomain || requestDomain;
      if (rule.excludedDomains && this.domainListHas(rule.excludedDomains, where)) return false;
      if (rule.domains && !this.domainListHas(rule.domains, where)) return false;
    }
    return true;
  }

  // A domain entry also covers everything under it.
  domainListHas(set, host) {
    if (!host) return false;
    let candidate = host;
    for (;;) {
      if (set.has(candidate)) return true;
      const dot = candidate.indexOf('.');
      if (dot === -1) return false;
      candidate = candidate.slice(dot + 1);
    }
  }

  matchIn(buckets, always, domains, url, tokens, host, type, requestDomain, documentDomain, isThirdParty) {
    // The domain rules first: it is one map lookup per label of the host,
    // and it is where most of the list lives.
    let candidate = host;
    for (;;) {
      const list = domains.get(candidate);
      if (list) {
        for (const rule of list) {
          if (this.ruleApplies(rule, type, requestDomain, documentDomain, isThirdParty)) return rule;
        }
      }
      const dot = candidate.indexOf('.');
      if (dot === -1) break;
      candidate = candidate.slice(dot + 1);
    }

    for (const rule of always) {
      if (rule.regex.test(url) &&
          this.ruleApplies(rule, type, requestDomain, documentDomain, isThirdParty)) {
        return rule;
      }
    }
    for (const token of tokens) {
      const list = buckets.get(token);
      if (!list) continue;
      for (const rule of list) {
        if (rule.regex.test(url) &&
            this.ruleApplies(rule, type, requestDomain, documentDomain, isThirdParty)) {
          return rule;
        }
      }
    }
    return null;
  }

  // The question every request asks. True means cancel it.
  shouldBlock(url, electronType, documentUrl) {
    if (!this.ruleCount) return false;
    const type = TYPE_MAP[electronType] || 'other';
    if (type === 'document') return false;   // never cancel a page you asked for

    const requestHost = hostOf(url);
    if (!requestHost) return false;

    const documentHost = hostOf(documentUrl);
    const requestDomain = registrableDomain(requestHost);
    const documentDomain = registrableDomain(documentHost);
    const isThirdParty = !!documentDomain && documentDomain !== requestDomain;

    const tokens = tokensOf(url);
    const blocked = this.matchIn(this.blockBuckets, this.blockAlways, this.blockDomains,
      url, tokens, requestHost, type, requestDomain, documentDomain, isThirdParty);
    if (!blocked) return false;

    // A rule saying "not this one" wins. That is how the list authors carve
    // out the sites a broad rule would otherwise break.
    const allowed = this.matchIn(this.allowBuckets, this.allowAlways, this.allowDomains,
      url, tokens, requestHost, type, requestDomain, documentDomain, isThirdParty);
    return !allowed;
  }

  // CSS for the boxes an ad used to sit in, so a blocked ad leaves a closed
  // gap rather than an empty one.
  hidingCssFor(pageUrl) {
    if (!this.cosmetic.size) return '';
    const host = hostOf(pageUrl);
    if (!host) return '';
    if (this.hidingCache.has(host)) return this.hidingCache.get(host);

    const selectors = [];
    let candidate = host;
    for (;;) {
      const list = this.cosmetic.get(candidate);
      if (list) selectors.push.apply(selectors, list);
      const dot = candidate.indexOf('.');
      if (dot === -1) break;
      candidate = candidate.slice(dot + 1);
    }

    const css = selectors.length ? selectors.join(',') + '{display:none !important;}' : '';
    if (this.hidingCache.size > 500) this.hidingCache.clear();
    this.hidingCache.set(host, css);
    return css;
  }
}

module.exports = { Engine, hostOf, registrableDomain, parseRule, patternToRegex, TYPE_MAP };
